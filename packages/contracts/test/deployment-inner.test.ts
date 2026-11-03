// The deployment check reads the key behind the verifier adapter and the tree's depth (the fifth review round, 2026-11-03): the
// fingerprint had named the adapter's address and nothing of the inner Groth16 verifier — the ceremony's or the development one,
// which accepts any proof —, and nothing of the depth the core was built at (3 to 32, the circuit fixed at 32).
import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import devVerifier from "../../../contracts/abi/dev/TransactionVerifierDev.json";
import { CIRCUIT_LEVELS, DEV_VERIFIER_CODEHASH, verifyDeployment, type DeploymentReader } from "../src/deployments";

const CORE = "0x00000000000000000000000000000000000000c0" as Address;
const FACTORY = "0x00000000000000000000000000000000000000fa" as Address;
const VERIFIER = "0x00000000000000000000000000000000000000ab" as Address;
const INNER = "0x00000000000000000000000000000000000000cd" as Address;
const ETH_VAULT = "0x00000000000000000000000000000000000000e7" as Address;
const ID = (n: number): Hex => ("0x" + n.toString(16).padStart(64, "0")) as Hex;

function reader(o: { innerCode?: Hex; levels?: bigint; getCode?: boolean } = {}): DeploymentReader {
  return {
    getChainId: async () => 1,
    readContract: async ({ address, functionName, args }) => {
      if (address === CORE)
        return (
          { PROTOCOL_ID: ID(1), CIRCUIT_ID: ID(2), HASH_ID: ID(3), VERIFIER, VAULT_FACTORY: FACTORY, LEVELS: o.levels ?? 32n } as Record<string, unknown>
        )[functionName];
      if (address === VERIFIER && functionName === "INNER") return INNER;
      if (address === FACTORY && functionName === "vaultOf")
        return String(args![0]) === "0x0000000000000000000000000000000000000000" ? ETH_VAULT : "0x0000000000000000000000000000000000000000";
      if (functionName === "VAULT_VERSION") return 1n;
      throw new Error(`unexpected read ${address}.${functionName}`);
    },
    ...(o.getCode === false ? {} : { getCode: async ({ address }) => (address === INNER ? (o.innerCode ?? ("0x6001600155" as Hex)) : undefined) }),
  };
}
const claim = (production: boolean) => ({ chainId: 1, core: CORE, assets: { eth: null }, ...(production ? { production: true } : {}) });

describe("the key behind the verifier and the tree's depth", () => {
  it("the inner verifier and its code hash are in the fingerprint; the development key is a problem in a production build and a fact on a devnet", async () => {
    const dev = devVerifier.deployedBytecode as Hex;
    const prod = await verifyDeployment(reader({ innerCode: dev }), claim(true));
    expect(prod.problems).toEqual(["the proof verifier is the development key, which accepts any proof: not a deployment to use"]);
    expect(prod.fingerprint.read.innerVerifier).toBe(INNER);
    expect(prod.fingerprint.read.innerVerifierCodehash).toBe(DEV_VERIFIER_CODEHASH.toLowerCase());
    const devnet = await verifyDeployment(reader({ innerCode: dev }), claim(false));
    expect(devnet.problems).toEqual([]);
    const ceremony = await verifyDeployment(reader(), claim(true));
    expect(ceremony.problems).toEqual([]);
    expect(ceremony.fingerprint.read.innerVerifierCodehash).not.toBe(DEV_VERIFIER_CODEHASH.toLowerCase());
    expect(ceremony.fingerprint.hash, "another key, another fingerprint").not.toBe(prod.fingerprint.hash);
  });
  it("a core built at another depth than the circuit's is a problem; an inner verifier without code is one; a reader without getCode reads neither", async () => {
    const shallow = await verifyDeployment(reader({ levels: 20n }), claim(true));
    expect(shallow.problems).toEqual([`the core's tree depth is 20, the circuit's is ${CIRCUIT_LEVELS}: no proof can ever verify`]);
    const empty = await verifyDeployment(reader({ innerCode: "0x" as Hex }), claim(true));
    expect(empty.problems).toEqual([`the proof verifier's inner key ${INNER} has no code`]);
    const blind = await verifyDeployment(reader({ getCode: false }), claim(true));
    expect(blind.problems).toEqual([]);
    expect(blind.fingerprint.read.innerVerifier).toBe(INNER);
    expect(blind.fingerprint.read.innerVerifierCodehash).toBeUndefined();
  });
});
