// The deployed verifier's own answer (spec v3.0 §7.3): `verifyProof(bytes proof, uint256[6] input)` of the shared
// Verifier, encoded by hand (the proof as websnark packs it: eight words a0 a1 b01 b00 b11 b10 c0 c1) and read back —
// the one verification that settles a proof before a withdrawal is submitted, and the live test's. Pure: the call
// data and the decoding; the transport is the caller's (src/net, Stage 9).
export const VERIFY_PROOF_SELECTOR = "0x695ef6f9" as const; // keccak256("verifyProof(bytes,uint256[6])")[0..4]

const word = (x: bigint | string | number): string => BigInt(x).toString(16).padStart(64, "0");

export interface VerifyCall {
  to: `0x${string}`;
  data: `0x${string}`;
}

/** The eth_call that asks the verifier whether `proof` (0x + 512 hex) proves `publicInputs` (six decimal strings). */
export function verifyProofCall(verifier: `0x${string}`, proof: `0x${string}`, publicInputs: readonly string[]): VerifyCall {
  if (!/^0x[0-9a-fA-F]{512}$/.test(proof)) throw new Error("a packed proof is 0x and 512 hex digits");
  if (publicInputs.length !== 6) throw new Error("six public inputs");
  const bytes = proof.slice(2);
  // the head: the offset of the dynamic bytes (after the offset word and the six static words), the six inputs;
  // the tail: the bytes' length, the bytes
  const data = VERIFY_PROOF_SELECTOR + word(32 + 6 * 32) + publicInputs.map(word).join("") + word(bytes.length / 2) + bytes;
  return { to: verifier, data: data as `0x${string}` };
}

/** The verifier's boolean, from the call's return data. */
export function verifiedOf(returnData: string): boolean {
  const hex = returnData.startsWith("0x") ? returnData.slice(2) : returnData;
  if (hex.length !== 64) throw new Error(`the verifier answered ${hex.length / 2} bytes, not a word`);
  return BigInt("0x" + hex) === 1n;
}
