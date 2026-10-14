// The deployment check (spec v2.0 §10): the same deployment always yields the same fingerprint; any change in what the
// chain says — the verifier, a vault, the identifiers — yields another, flagged against the remembered one; a wrong chain,
// a missing vault and mixed vault versions are named.
import { describe, expect, it } from "vitest";
import { ABI, BYTECODE, verifyDeployment, type DeploymentReader } from "../src";
import escrowJson from "../../../contracts/abi/periphery/SwapOrderEscrow.json";

const CORE = "0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9" as const;
const FACTORY = "0x00000000000000000000000000000000000000f1";
const ETH_VAULT = "0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const USDC_VAULT = "0x00000000000000000000000000000000000000c2";
const ID = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

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
            PROTOCOL_ID: ID(1),
            CIRCUIT_ID: ID(2),
            HASH_ID: ID(3),
            VERIFIER: o.verifier ?? "0x00000000000000000000000000000000000000Ab",
            VAULT_FACTORY: FACTORY,
          } as Record<string, unknown>
        )[functionName];
      if (address === FACTORY && functionName === "vaultOf") return vaults[String(args![0]).toLowerCase()] ?? "0x0000000000000000000000000000000000000000";
      if (functionName === "VAULT_VERSION") return BigInt(o.versions?.[address] ?? 1);
      if (address === SHIELD_FACTORY && functionName === "VAULT_FACTORY") return o.shieldPool ?? FACTORY;
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
    expect(a.fingerprint.read.protocolVersion).toBe(`${ID(1)}/${ID(2)}/${ID(3)}`);
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
