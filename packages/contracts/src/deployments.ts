// The deployment check (doc §71; spec v2.0 §10): what the chain says the configured contracts are — the core's protocol,
// circuit and hash identifiers, its verifier and vault factory, the canonical vault of every registry asset and its
// version — condensed to a fingerprint. The wallet remembers the fingerprint it first saw for a chain; a different one
// is a blocking notice ("This app does not match the deployed protocol."), never a silent switch.
import { keccak256, stringToHex, type Address, type Hex } from "viem";
import type { DeploymentFingerprint, ProtocolDeployment } from "@privacy-wallet/protocol-types";

const ZERO = "0x0000000000000000000000000000000000000000";

const CORE_ABI = [
  { type: "function", name: "PROTOCOL_ID", stateMutability: "pure", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "CIRCUIT_ID", stateMutability: "pure", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "HASH_ID", stateMutability: "pure", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "VERIFIER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "VAULT_FACTORY", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const FACTORY_ABI = [{ type: "function", name: "vaultOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] }] as const;
const VAULT_ABI = [{ type: "function", name: "VAULT_VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;

/** The two reads the check needs (a viem PublicClient satisfies it; tests pass a fake). */
export interface DeploymentReader {
  getChainId(): Promise<number>;
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
}

export interface DeploymentClaim {
  chainId: number;
  core: Address;
  /** asset id → token address (null = the native asset); each must have a canonical vault */
  assets: Record<string, Address | null>;
  swapFactory?: Address;
  protectRouter?: Address;
  shieldFactory?: Address;
  feeRecipient?: Address;
}

export interface DeploymentCheck {
  fingerprint: DeploymentFingerprint;
  /** what does not hold: a wrong chain, an asset without a vault, a vault of another version */
  problems: string[];
  /** a fingerprint was remembered for this chain and this one differs */
  changed: boolean;
}

const lower = (a: string): Address => a.toLowerCase() as Address;

/** Canonical JSON: keys sorted at every level, addresses lowercase (two reads of the same deployment hash the same). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) return JSON.stringify(v.toLowerCase());
  return JSON.stringify(v);
}

export const fingerprintHash = (read: DeploymentFingerprint["read"]): Hex => keccak256(stringToHex(canonicalJson(read)));

/** Reads the deployment a configuration claims and compares it with what the wallet remembered for that chain. */
export async function verifyDeployment(client: DeploymentReader, claim: DeploymentClaim, remembered?: Hex | null): Promise<DeploymentCheck> {
  const problems: string[] = [];
  const chainId = await client.getChainId();
  if (chainId !== claim.chainId) problems.push(`the endpoints answer chain ${chainId}, the configuration names chain ${claim.chainId}`);
  const core = claim.core;
  const read = (functionName: (typeof CORE_ABI)[number]["name"]) => client.readContract({ address: core, abi: CORE_ABI, functionName });
  const [protocolId, circuitId, hashId, verifier, vaultFactory] = (await Promise.all([
    read("PROTOCOL_ID"),
    read("CIRCUIT_ID"),
    read("HASH_ID"),
    read("VERIFIER"),
    read("VAULT_FACTORY"),
  ])) as [Hex, Hex, Hex, Address, Address];
  const vaults: Record<string, Address> = {};
  let vaultVersion = 0;
  for (const [id, token] of Object.entries(claim.assets).sort(([a], [b]) => a.localeCompare(b))) {
    const vault = (await client.readContract({ address: vaultFactory, abi: FACTORY_ABI, functionName: "vaultOf", args: [token ?? ZERO] })) as Address;
    if (lower(vault) === ZERO) {
      problems.push(`no canonical vault for ${id}`);
      continue;
    }
    vaults[id] = lower(vault);
    const v = Number(await client.readContract({ address: vault, abi: VAULT_ABI, functionName: "VAULT_VERSION" }));
    if (vaultVersion && v !== vaultVersion) problems.push(`the vault of ${id} is version ${v}, the others ${vaultVersion}`);
    vaultVersion ||= v;
  }
  const deployment: ProtocolDeployment = {
    chainId,
    protocolVersion: `${protocolId}/${circuitId}/${hashId}`,
    privacyCore: lower(core),
    verifier: lower(verifier),
    vaultFactory: lower(vaultFactory),
    vaults,
    ...(claim.swapFactory ? { swapFactory: lower(claim.swapFactory) } : {}),
    ...(claim.protectRouter ? { protectRouter: lower(claim.protectRouter) } : {}),
    ...(claim.shieldFactory ? { shieldFactory: lower(claim.shieldFactory) } : {}),
    ...(claim.feeRecipient ? { feeRecipient: lower(claim.feeRecipient) } : {}),
  };
  const fingerprint: DeploymentFingerprint = { chainId, hash: fingerprintHash({ ...deployment, vaultVersion }), read: { ...deployment, vaultVersion } };
  return { fingerprint, problems, changed: !!remembered && remembered.toLowerCase() !== fingerprint.hash.toLowerCase() };
}
