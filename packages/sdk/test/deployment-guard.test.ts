// The deployment check before the first operation (doc §71; spec v2.0 §10): the first sight of a deployment is remembered
// in the encrypted journal and not read again in the session; a deployment that reads differently — another verifier, a
// configured vault that is not the canonical one, a ProtectRouter of another core, another chain — blocks with
// `deployment_mismatch` (nothing moved, a final failure); forgetting it under Advanced lets the next operation remember
// what it reads; a failed read is not a mismatch and is tried again; the engine's money functions refuse before any request.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DeploymentReader } from "@privacy-wallet/contracts";
import { ContractFunctionExecutionError, ContractFunctionZeroDataError } from "viem";
import { configure, defaultConfig } from "../src/config";
import type { Deployment } from "../src/chain";
import { DeploymentMismatch, claimOf, forgetDeployment, guardDeployment, rememberedFingerprint, resetDeploymentGuard } from "../src/deploymentGuard";
import { classify, failureTarget } from "../src/operations/errors/catalog";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";

const CORE = "0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9" as const;
const FACTORY = "0x00000000000000000000000000000000000000f1";
const ETH_VAULT = "0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469" as const;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const USDC_VAULT = "0x00000000000000000000000000000000000000C2" as const;
const ROUTER = "0x00000000000000000000000000000000000000a1" as const;
const ZERO = "0x0000000000000000000000000000000000000000";
const ID = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const deployment: Deployment = {
  chainId: 1,
  core: CORE,
  ethVault: ETH_VAULT,
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [{ symbol: "USDC", decimals: 6, token: USDC, vault: USDC_VAULT }],
  protectRouter: ROUTER,
};

/** A chain as the reader sees it; `reads` counts every call; `predict`: what a factory answers for the probe (null: no contract). */
function chain(
  o: {
    chainId?: number;
    verifier?: string;
    routerCore?: string;
    fail?: boolean;
    predict?: Record<string, string | null>;
    usdcDecimals?: number | null | Error;
  } = {},
) {
  const reader = {
    reads: 0,
    getChainId: async () => {
      reader.reads++;
      if (o.fail) throw new Error("fetch failed");
      return o.chainId ?? 1;
    },
    readContract: async ({ address, functionName, args }: { address: string; functionName: string; args?: readonly unknown[] }) => {
      reader.reads++;
      if (address === CORE)
        return (
          {
            PROTOCOL_ID: ID(1),
            CIRCUIT_ID: ID(2),
            HASH_ID: ID(3),
            VERIFIER: o.verifier ?? "0x00000000000000000000000000000000000000Ab",
            VAULT_FACTORY: FACTORY,
            LEVELS: 32n,
          } as Record<string, unknown>
        )[functionName];
      if (functionName === "INNER") return "0x00000000000000000000000000000000000000Cd"; // the key behind the adapter (the fifth review round, 2026-11-03)
      if (address === FACTORY && functionName === "vaultOf")
        return ({ [ZERO]: ETH_VAULT, [USDC.toLowerCase()]: USDC_VAULT } as Record<string, string>)[String(args![0]).toLowerCase()] ?? ZERO;
      if (functionName === "VAULT_VERSION") return 1n;
      if (address === ROUTER && functionName === "CORE") return o.routerCore ?? CORE;
      if (address.toLowerCase() === USDC.toLowerCase() && functionName === "decimals") {
        const d = o.usdcDecimals === undefined ? 6 : o.usdcDecimals;
        if (d instanceof Error) throw d;
        if (d === null)
          throw new ContractFunctionExecutionError(new ContractFunctionZeroDataError({ functionName: "decimals" }), { abi: [], functionName: "decimals" });
        return d;
      }
      if (functionName === "predict" && o.predict && address.toLowerCase() in o.predict) {
        const answer = o.predict[address.toLowerCase()];
        if (answer === null)
          throw new ContractFunctionExecutionError(new ContractFunctionZeroDataError({ functionName: "predict" }), { abi: [], functionName: "predict" });
        return answer;
      }
      throw new Error(`unexpected read ${address}.${functionName}`);
    },
  };
  return reader satisfies DeploymentReader;
}

let reader = chain();
vi.mock("../src/chain", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/chain")>()), clientFor: () => reader }));

const store = memoryStorage();
beforeAll(async () => {
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
});
afterEach(() => {
  resetDeploymentGuard();
  forgetDeployment(1);
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  reader = chain();
});

describe("the deployment check before the first operation (doc §71)", () => {
  it("claims every asset of the deployment and the periphery it names", () => {
    expect(claimOf(deployment)).toEqual({ chainId: 1, core: CORE, assets: { eth: null, usdc: USDC }, protectRouter: ROUTER });
  });

  it("the first sight is remembered in the journal and not read again in the session", async () => {
    expect(rememberedFingerprint(1)).toBeNull();
    const hash = await guardDeployment(deployment, reader);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(rememberedFingerprint(1)).toBe(hash);
    expect(session.journal().deploymentFingerprints).toEqual({ "1": hash });
    const reads = reader.reads;
    expect(await guardDeployment(deployment, reader)).toBe(hash);
    expect(reader.reads, "verified against this journal: no read").toBe(reads);
    resetDeploymentGuard(); // a new session of the app: read again, the same deployment passes
    expect(await guardDeployment(deployment, reader)).toBe(hash);
  });

  it("a deployment that reads differently than the one remembered blocks: deployment_mismatch, nothing moved, a final failure", async () => {
    await guardDeployment(deployment, reader);
    resetDeploymentGuard();
    const e = await guardDeployment(deployment, chain({ verifier: "0x00000000000000000000000000000000000000cd" })).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DeploymentMismatch);
    expect(e).toMatchObject({ changed: true, problems: [] });
    expect((e as Error).message).toMatch(/does not match the deployed protocol/);
    const c = classify(e);
    expect(c).toMatchObject({ code: "deployment_mismatch", fundsClass: "not-moved", actions: ["check-settings"] });
    expect(failureTarget(c), "nothing to track or return: FAILED").toBe("FAILED");
  });

  it("names what does not hold: a configured vault that is not the canonical one, a ProtectRouter of another core, another chain", async () => {
    const wrongVault = { ...deployment, ethVault: "0x00000000000000000000000000000000000000e7" as const };
    await expect(guardDeployment(wrongVault, reader)).rejects.toMatchObject({
      changed: false,
      problems: ["the configured vault of ETH is not the canonical one"],
    });
    await expect(guardDeployment(deployment, chain({ routerCore: "0x00000000000000000000000000000000000000c0" }))).rejects.toMatchObject({
      problems: ["ProtectRouter answers to another core"],
    });
    await expect(guardDeployment(deployment, chain({ chainId: 5 }))).rejects.toMatchObject({ problems: [expect.stringMatching(/answer chain 5.*chain 1/)] });
    expect(rememberedFingerprint(1), "a refused deployment is never remembered").toBeNull();
  });

  it("forgetting it under Advanced is the deliberate way through: the next operation remembers what it reads", async () => {
    const first = await guardDeployment(deployment, reader);
    resetDeploymentGuard();
    const other = chain({ verifier: "0x00000000000000000000000000000000000000cd" });
    await expect(guardDeployment(deployment, other)).rejects.toBeInstanceOf(DeploymentMismatch);
    forgetDeployment(1);
    expect(rememberedFingerprint(1)).toBeNull();
    const second = await guardDeployment(deployment, other);
    expect(second).not.toBe(first);
    expect(rememberedFingerprint(1)).toBe(second);
  });

  it("a failed read is not a mismatch and is tried again; the test configuration turns the check off", async () => {
    const down = chain({ fail: true });
    const e = await guardDeployment(deployment, down).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(DeploymentMismatch);
    expect(classify(e).code).toBe("relayer_unreachable"); // the transport's words: a network failure, nothing moved yet
    expect(await guardDeployment(deployment, reader)).toMatch(/^0x/);
    resetDeploymentGuard();
    forgetDeployment(1);
    configure(defaultConfig({ storage: () => store, kdfLog2N: 12, deploymentCheck: false }));
    const off = chain();
    expect(await guardDeployment(deployment, off)).toBeNull();
    expect(off.reads).toBe(0);
  });

  it("the engine's money functions refuse before any request when the deployment does not match", async () => {
    const { privateTransfer, privateWithdrawal, privacyAddress } = await import("../src/privateTx");
    await guardDeployment(deployment, reader); // remembered
    resetDeploymentGuard();
    reader = chain({ verifier: "0x00000000000000000000000000000000000000cd" }); // what clientFor now answers
    const events: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const to = privacyAddress(new Uint8Array(32).fill(9));
    await expect(
      privateTransfer({ masterSeed: session.state().seed!, deployment, amount: 1n, recipient: to, onEvent: (e) => events.push(e.type) }),
    ).rejects.toBeInstanceOf(DeploymentMismatch);
    await expect(
      privateWithdrawal({ masterSeed: session.state().seed!, deployment, amount: 1n, recipient: ETH_VAULT, onEvent: (e) => events.push(e.type) }),
    ).rejects.toBeInstanceOf(DeploymentMismatch);
    expect(events, "no fee terms, no sync, no proof").toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("a configured token's decimals (audit round 2, critic gap 1)", () => {
  it("are the token's own: other decimals, or none answered, block before any money moves; a failed read is tried again", async () => {
    const wrong: Deployment = { ...deployment, erc20Vaults: [{ symbol: "USDC", decimals: 18, token: USDC, vault: USDC_VAULT }] };
    let e = await guardDeployment(wrong).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DeploymentMismatch);
    expect((e as DeploymentMismatch).problems.join(" ")).toMatch(/configured decimals of USDC \(18\) are not the token's \(6\)/);
    expect(rememberedFingerprint(1), "nothing remembered").toBeNull();
    resetDeploymentGuard();
    reader = chain({ usdcDecimals: null });
    e = await guardDeployment(deployment).catch((x: unknown) => x);
    expect((e as DeploymentMismatch).problems.join(" ")).toMatch(/USDC answers no decimals\(\)/);
    resetDeploymentGuard();
    const down = new Error("fetch failed");
    reader = chain({ usdcDecimals: down });
    await expect(guardDeployment(deployment), "a failed read: the read's own error").rejects.toBe(down);
    resetDeploymentGuard();
    reader = chain();
    await expect(guardDeployment(deployment), "the token's own decimals").resolves.toMatch(/^0x/);
  });
});

describe("the factories' own predictions (audit round 2, critic gap 1)", () => {
  it("a swap factory that would put the probe elsewhere, or no contract there, blocks before any money moves; this app's own passes", async () => {
    const SWAP = "0x00000000000000000000000000000000000000f2" as const;
    const withFactory: Deployment = { ...deployment, swapFactory: SWAP };
    // a factory of another escrow version: its predict answers another address
    reader = chain({ predict: { [SWAP]: "0x00000000000000000000000000000000000000e5" } });
    let e = await guardDeployment(withFactory).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DeploymentMismatch);
    expect((e as DeploymentMismatch).problems.join(" ")).toMatch(/creates escrows other than this app's/);
    expect(rememberedFingerprint(1), "nothing remembered").toBeNull();
    // no contract at the address
    resetDeploymentGuard();
    reader = chain({ predict: { [SWAP]: null } });
    e = await guardDeployment(withFactory).catch((x: unknown) => x);
    expect((e as DeploymentMismatch).problems.join(" ")).toMatch(/no swap order factory answers/);
    // the factory of this app's escrow code
    const { probeEscrowOf } = await import("@privacy-wallet/contracts/factoryProbe");
    resetDeploymentGuard();
    reader = chain({ predict: { [SWAP]: probeEscrowOf(SWAP) } });
    await expect(guardDeployment(withFactory)).resolves.toMatch(/^0x/);
  });
});
