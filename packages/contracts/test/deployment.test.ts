// The deployment check (spec v2.0 §10): the same deployment always yields the same fingerprint; any change in what the
// chain says — the verifier, a vault, the identifiers — yields another, flagged against the remembered one; a wrong chain,
// a missing vault and mixed vault versions are named.
import { describe, expect, it } from "vitest";
import { ContractFunctionExecutionError, ContractFunctionZeroDataError, HttpRequestError } from "viem";
import { ABI, BYTECODE, verifyDeployment, type DeploymentReader } from "../src";
import escrowJson from "../../../contracts/abi/periphery/SwapOrderEscrow.json";
import { CORE_IDS, POSEIDON2_ONE_TWO_THREE, WRAPPED_NATIVE_OF } from "../src/deployments";

const CORE = "0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9" as const;
const FACTORY = "0x00000000000000000000000000000000000000f1";
const ETH_VAULT = "0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const USDC_VAULT = "0x00000000000000000000000000000000000000c2";
const HASHER = "0x00000000000000000000000000000000000000E5" as const; // the core's Poseidon2 hasher

const SHIELD_FACTORY = "0x00000000000000000000000000000000000000f5";

function chain(
  o: { chainId?: number; verifier?: string; vaults?: Record<string, string>; versions?: Record<string, number>; shieldPool?: string } = {},
): DeploymentReader {
  const vaults = o.vaults ?? { "0x0000000000000000000000000000000000000000": ETH_VAULT, [USDC.toLowerCase()]: USDC_VAULT };
  return {
    getChainId: async () => o.chainId ?? 1,
    readContract: async ({ address, functionName, args }) => {
      if (address === CORE)
        return (
          {
            PROTOCOL_ID: CORE_IDS.protocolId,
            CIRCUIT_ID: CORE_IDS.circuitId,
            HASH_ID: CORE_IDS.hashId,
            VERIFIER: o.verifier ?? "0x00000000000000000000000000000000000000Ab",
            VAULT_FACTORY: FACTORY,
            LEVELS: 32n,
            HASHER,
          } as Record<string, unknown>
        )[functionName];
      if (functionName === "INNER") return "0x00000000000000000000000000000000000000Cd"; // the key behind the adapter (the fifth review round, 2026-11-03)
      if (address === FACTORY && functionName === "vaultOf") return vaults[String(args![0]).toLowerCase()] ?? "0x0000000000000000000000000000000000000000";
      if (functionName === "VAULT_VERSION") return BigInt(o.versions?.[address] ?? 1);
      if (address === SHIELD_FACTORY && functionName === "VAULT_FACTORY") return o.shieldPool ?? FACTORY;
      if (functionName === "poseidon2") return POSEIDON2_ONE_TWO_THREE; // the build's Poseidon2 on [1, 2, 3] (the eleventh review round, G11-1)
      if (functionName === "WRAPPED_NATIVE") return WRAPPED_NATIVE_OF[1]; // both factories take the chain's WETH (G11-6)
      throw new Error(`unexpected read ${address}.${functionName}`);
    },
  };
}
const claim = { chainId: 1, core: CORE, assets: { eth: null, usdc: USDC } };

describe("verifyDeployment", () => {
  it("is stable: two reads of the same deployment give the same fingerprint, no problem, no change", async () => {
    const a = await verifyDeployment(chain(), claim);
    const b = await verifyDeployment(chain(), { ...claim, core: CORE }, a.fingerprint.hash);
    expect(a.problems).toEqual([]);
    expect(b.fingerprint.hash).toBe(a.fingerprint.hash);
    expect(b.changed).toBe(false);
    expect(a.fingerprint.read.vaults).toEqual({ eth: ETH_VAULT.toLowerCase(), usdc: USDC_VAULT });
    expect(a.fingerprint.read.protocolVersion).toBe(`${CORE_IDS.protocolId}/${CORE_IDS.circuitId}/${CORE_IDS.hashId}`);
  });

  it("a different verifier or vault is a different fingerprint — flagged against the remembered one, never adopted silently", async () => {
    const before = await verifyDeployment(chain(), claim);
    const verifier = await verifyDeployment(chain({ verifier: "0x00000000000000000000000000000000000000cd" }), claim, before.fingerprint.hash);
    const vault = await verifyDeployment(
      chain({ vaults: { "0x0000000000000000000000000000000000000000": "0x00000000000000000000000000000000000000e9", [USDC.toLowerCase()]: USDC_VAULT } }),
      claim,
      before.fingerprint.hash,
    );
    expect(verifier.changed).toBe(true);
    expect(vault.changed).toBe(true);
    expect(new Set([before.fingerprint.hash, verifier.fingerprint.hash, vault.fingerprint.hash]).size).toBe(3);
    expect((await verifyDeployment(chain(), claim, null)).changed, "nothing remembered yet: the first sight").toBe(false);
  });

  it("names a wrong chain, an asset without a canonical vault, and mixed vault versions", async () => {
    expect((await verifyDeployment(chain({ chainId: 5 }), claim)).problems[0]).toMatch(/answer chain 5.*chain 1/);
    expect((await verifyDeployment(chain({ vaults: { "0x0000000000000000000000000000000000000000": ETH_VAULT } }), claim)).problems).toEqual([
      "no canonical vault for usdc",
    ]);
    expect((await verifyDeployment(chain({ versions: { [USDC_VAULT]: 2 } }), claim)).problems[0]).toMatch(/usdc is version 2/);
  });

  it("V6 Stage 12: a shield receiver factory of another pool is named; this pool's is part of the fingerprint", async () => {
    const ok = await verifyDeployment(chain(), { ...claim, shieldFactory: SHIELD_FACTORY });
    expect(ok.problems).toEqual([]);
    expect(ok.fingerprint.read.shieldFactory).toBe(SHIELD_FACTORY);
    expect(ok.fingerprint.hash).not.toBe((await verifyDeployment(chain(), claim)).fingerprint.hash);
    const other = await verifyDeployment(chain({ shieldPool: "0x00000000000000000000000000000000000000f9" }), { ...claim, shieldFactory: SHIELD_FACTORY });
    expect(other.problems[0]).toMatch(/shield receiver factory deposits into 0x0+f9, not this core's vault factory/);
  });

  it("a failed read of the shield factory is the read's own error, tried again; only the chain's answer names no factory (audit round 2, n41)", async () => {
    const failing = (cause: Error): DeploymentReader => {
      const base = chain();
      return {
        ...base,
        readContract: async (q) => {
          if (q.address === SHIELD_FACTORY) throw cause;
          return base.readContract(q);
        },
      };
    };
    const withShield = { ...claim, shieldFactory: SHIELD_FACTORY } as const;
    // an endpoint that did not answer: it had read as "no pool", a blocking mismatch
    const down = new ContractFunctionExecutionError(new HttpRequestError({ url: "http://rpc.example", details: "fetch failed" }), {
      abi: [],
      functionName: "VAULT_FACTORY",
    });
    await expect(verifyDeployment(failing(down), withShield)).rejects.toBe(down);
    // the chain answers that no such contract is there
    const none = new ContractFunctionExecutionError(new ContractFunctionZeroDataError({ functionName: "VAULT_FACTORY" }), {
      abi: [],
      functionName: "VAULT_FACTORY",
    });
    expect((await verifyDeployment(failing(none), withShield)).problems[0]).toMatch(/shield receiver factory deposits into no pool/);
  });

  it("the address case of the claim does not change the fingerprint", async () => {
    const a = await verifyDeployment(chain(), { ...claim, swapFactory: "0xA0Cb889707d426A7A386870A03bc70d1b0697598" });
    const b = await verifyDeployment(chain(), { ...claim, swapFactory: "0xa0cb889707d426a7a386870a03bc70d1b0697598" });
    expect(a.fingerprint.hash).toBe(b.fingerprint.hash);
  });
});

describe("the ABIs", () => {
  it("are forge's exports: the core's identifiers, the factory's lookup, the escrow's creation code byte for byte", () => {
    const names = (abi: readonly unknown[]) => abi.map((x) => (x as { name?: string }).name);
    expect(names(ABI.privacyCore)).toEqual(expect.arrayContaining(["PROTOCOL_ID", "CIRCUIT_ID", "HASH_ID", "VERIFIER", "VAULT_FACTORY", "transact"]));
    expect(names(ABI.assetVaultFactory)).toEqual(expect.arrayContaining(["vaultOf", "isCanonical"]));
    expect(BYTECODE.swapOrderEscrow).toBe(escrowJson.bytecode);
    expect(BYTECODE.swapOrderEscrow.startsWith("0x")).toBe(true);
    expect(names(ABI.shieldReceiverFactory)).toEqual(
      expect.arrayContaining(["predict", "deployAndShield", "deployAndShieldToken", "VAULT_FACTORY", "WRAPPED_NATIVE"]),
    );
    expect(names(ABI.shieldReceiver)).toEqual(expect.arrayContaining(["shield", "shieldToken", "sweepUnsupported", "tipPaid"]));
    expect(BYTECODE.shieldReceiver.startsWith("0x")).toBe(true);
  });
});
