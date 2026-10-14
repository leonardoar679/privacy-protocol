// The deployment check before the first operation (doc §71; spec v2.0 §10): before a session's first money operation —
// a protect, a send, a withdrawal, a swap's funding, a merge or a split — the engine reads what the configured contracts
// are (@privacy-wallet/contracts verifyDeployment: the core's protocol, circuit and hash identifiers, its verifier and
// vault factory, the canonical vault of every asset and its version), checks that the configured vaults are those
// canonical vaults, that ProtectRouter answers to this core and the shield receiver factory deposits into its pool, and compares the fingerprint with the one this wallet
// remembered for the chain (the encrypted journal's optional `deploymentFingerprints`). A problem or a changed
// fingerprint is a blocking error — "This app does not match the deployed protocol." — never a silent switch; the first
// sight is remembered. Nothing is read before the user confirms an operation (first launch stays request-free), and a
// deployment verified against this journal is not read again in the session. More → Advanced can forget the remembered
// fingerprint: a deliberate act, after which the next operation remembers what it reads.
import type { Address, Hex } from "viem";
import { verifyDeployment, type DeploymentClaim, type DeploymentReader } from "@privacy-wallet/contracts";
import { assetsOf } from "./assets";
import { clientFor, type Deployment } from "./chain";
import { config } from "./config";
import { session } from "./wallet/session";

/** The blocking error: classified as `deployment_mismatch` (nothing was sent). */
export class DeploymentMismatch extends Error {
  readonly code = "deployment_mismatch";
  constructor(
    readonly problems: string[],
    readonly changed: boolean,
  ) {
    super(
      `this app does not match the deployed protocol: ${[...(changed ? ["the deployment differs from the one this wallet remembered for this chain"] : []), ...problems].join("; ")}`,
    );
    this.name = "DeploymentMismatch";
  }
}

const ROUTER_ABI = [{ type: "function", name: "CORE", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const keyOf = (d: Deployment) => `${d.chainId}:${d.core.toLowerCase()}`;

/** What the configuration claims: the core, every asset of the deployment by symbol, the periphery it names. */
export function claimOf(d: Deployment): DeploymentClaim {
  return {
    chainId: d.chainId,
    core: d.core,
    assets: Object.fromEntries(assetsOf(d).map((a) => [a.symbol.toLowerCase(), (a.token ?? null) as Address | null])),
    ...(d.swapFactory ? { swapFactory: d.swapFactory } : {}),
    ...(d.protectRouter ? { protectRouter: d.protectRouter } : {}),
    ...(d.shieldFactory ? { shieldFactory: d.shieldFactory } : {}),
  };
}

/** The fingerprint this wallet remembered for a chain (the journal), or null. */
export const rememberedFingerprint = (chainId: number): string | null =>
  session.isUnlocked() ? (session.journal().deploymentFingerprints?.[String(chainId)] ?? null) : null;

/** More → Advanced: forget the remembered fingerprint of a chain; the next operation remembers what it reads. */
export function forgetDeployment(chainId: number): void {
  session.update((j) => {
    if (!j.deploymentFingerprints) return;
    const rest = { ...j.deploymentFingerprints };
    delete rest[String(chainId)];
    j.deploymentFingerprints = rest;
  });
  for (const k of [...verified.keys()]) if (k.startsWith(`${chainId}:`)) verified.delete(k);
}

const verified = new Map<string, string>(); // deployment → the fingerprint verified in this session
const inflight = new Map<string, Promise<string>>();

/**
 * Checks the deployment before a money operation; resolves with its fingerprint hash (null when the check is turned off,
 * as the test configuration does). Throws DeploymentMismatch when the chain does not say what the configuration claims,
 * or says something else than this wallet remembered; a failed read throws the read's own error (tried again next time).
 */
export async function guardDeployment(d: Deployment, reader?: DeploymentReader): Promise<string | null> {
  if (config().deploymentCheck === false) return null;
  const key = keyOf(d);
  const remembered = rememberedFingerprint(d.chainId);
  const known = verified.get(key);
  if (known && same(known, remembered ?? undefined)) return known; // verified in this session against this journal
  let p = inflight.get(key);
  if (!p) {
    p = check(d, reader ?? (clientFor(d) as unknown as DeploymentReader), remembered).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

async function check(d: Deployment, reader: DeploymentReader, remembered: string | null): Promise<string> {
  const result = await verifyDeployment(reader, claimOf(d), remembered as Hex | null);
  const problems = [...result.problems];
  // the configured vaults must be the canonical ones the core's factory names
  for (const a of assetsOf(d)) {
    const canonical = result.fingerprint.read.vaults[a.symbol.toLowerCase()];
    if (canonical && !same(canonical, a.vault)) problems.push(`the configured vault of ${a.symbol} is not the canonical one`);
  }
  // ProtectRouter must answer to this core
  if (d.protectRouter) {
    const core = (await reader.readContract({ address: d.protectRouter, abi: ROUTER_ABI, functionName: "CORE" })) as string;
    if (!same(core, d.core)) problems.push("ProtectRouter answers to another core");
  }
  if (problems.length || result.changed) throw new DeploymentMismatch(problems, result.changed);
  const hash = result.fingerprint.hash;
  if (!remembered && session.isUnlocked()) {
    session.update((j) => {
      j.deploymentFingerprints = { ...(j.deploymentFingerprints ?? {}), [String(d.chainId)]: hash };
    });
  }
  verified.set(keyOf(d), hash);
  return hash;
}

/** Tests: forget what this session verified. */
export function resetDeploymentGuard(): void {
  verified.clear();
  inflight.clear();
}
