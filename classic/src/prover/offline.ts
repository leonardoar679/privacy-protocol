// Verifying a proof on the device (spec v3.0 §7.3): snarkjs 0.7.6's Groth16 verifier over the key the deployed
// Verifier.sol carries (src/config/deployment.json, read from the chain and the verified source in Stage 5). The
// Solidity verifier keeps every G2 coordinate imaginary part first (the precompile's order); snarkjs wants the real part
// first — both the key and the packed proof's B are reordered here. Proven right by the live verifier: a proof this
// accepts, the contract accepts (test/live/verifier.live.test.ts). Nothing here reaches the network.
import { groth16 } from "snarkjs";
import DEPLOYMENT from "../config/deployment.json";

type G1 = readonly [string, string];
type G2 = readonly [readonly [string, string], readonly [string, string]];
export interface SolidityVerifyingKey {
  alfa1: G1;
  beta2: G2;
  gamma2: G2;
  delta2: G2;
  IC: readonly G1[];
  nPublic: number;
}

export const DEPLOYED_KEY = DEPLOYMENT.verifier.vk as unknown as SolidityVerifyingKey;

const g1 = (p: G1) => [p[0], p[1], "1"];
const g2 = (q: G2) => [
  [q[0][1], q[0][0]],
  [q[1][1], q[1][0]],
  ["1", "0"],
];

/** The key as snarkjs reads it. */
export function snarkjsKey(vk: SolidityVerifyingKey = DEPLOYED_KEY) {
  return {
    protocol: "groth16",
    curve: "bn128",
    nPublic: vk.nPublic,
    vk_alpha_1: g1(vk.alfa1),
    vk_beta_2: g2(vk.beta2),
    vk_gamma_2: g2(vk.gamma2),
    vk_delta_2: g2(vk.delta2),
    IC: vk.IC.map(g1),
  };
}

/** The packed proof's eight words (a0 a1 b01 b00 b11 b10 c0 c1) as snarkjs's proof. */
export function unpackProof(packed: `0x${string}`) {
  if (!/^0x[0-9a-fA-F]{512}$/.test(packed)) throw new Error("a packed proof is 0x and 512 hex digits");
  const w = Array.from({ length: 8 }, (_, i) => BigInt("0x" + packed.slice(2 + 64 * i, 66 + 64 * i)).toString());
  return {
    protocol: "groth16",
    curve: "bn128",
    pi_a: [w[0], w[1], "1"],
    pi_b: [
      [w[3], w[2]],
      [w[5], w[4]],
      ["1", "0"],
    ],
    pi_c: [w[6], w[7], "1"],
  };
}

/** True when the proof proves the six public inputs under the deployed verifier's key. */
export async function verifyOffline(packed: `0x${string}`, publicInputs: readonly string[], vk: SolidityVerifyingKey = DEPLOYED_KEY): Promise<boolean> {
  if (publicInputs.length !== vk.nPublic) throw new Error(`${vk.nPublic} public inputs`);
  return (
    (await groth16.verify(
      snarkjsKey(vk),
      publicInputs.map((x) => BigInt(x).toString()),
      unpackProof(packed),
    )) === true
  );
}
