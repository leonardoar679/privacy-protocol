// PrivacyCore.transact ABI (frozen, docs/protocol-spec-v1.0.md §14) and the public-input struct.
import { decodeFunctionData, encodeFunctionData, parseAbi, type Hex } from "viem";

export const coreAbi = parseAbi([
  "function transact(bytes proof, (uint256 root, uint256 nullifier0, uint256 nullifier1, uint256 outputBody0, uint256 outputBody1, uint256 outputBody2, uint256 mode, uint256 withdrawalVault, uint256 withdrawalAmount, uint256 withdrawalRecipient, uint256 noteData0Hash, uint256 noteData1Hash, uint256 noteData2Hash, uint256 txDomain) pi, bytes noteData0, bytes noteData1, bytes noteData2)",
  "function isNullifierSpent(uint256 nullifier) view returns (bool)",
  "function isKnownRoot(bytes32 root) view returns (bool)",
  "function currentRoot() view returns (bytes32)",
  "function TX_DOMAIN() view returns (uint256)",
  "event NoteInserted(uint32 indexed leafIndex, uint256 commitment, bytes noteData)",
]);

/** The circuit's public signals in CoreTypes.PublicInputs order (same as packages/protocol/src/prover.ts). */
export const PUBLIC_SIGNALS = [
  "root", "nullifier0", "nullifier1", "outputBody0", "outputBody1", "outputBody2", "mode",
  "withdrawalVault", "withdrawalAmount", "withdrawalRecipient", "noteData0Hash", "noteData1Hash", "noteData2Hash", "txDomain",
] as const;
export type PublicInputs = Record<(typeof PUBLIC_SIGNALS)[number], bigint>;

export function piFromStrings(xs: (string | bigint)[]): PublicInputs {
  if (!Array.isArray(xs) || xs.length !== 14) throw new Error(`expected 14 public inputs, got ${Array.isArray(xs) ? xs.length : typeof xs}`);
  return Object.fromEntries(PUBLIC_SIGNALS.map((k, i) => [k, BigInt(xs[i])])) as PublicInputs;
}

export function encodeTransact(proof: Hex, pi: PublicInputs, noteData: [Hex, Hex, Hex]): Hex {
  return encodeFunctionData({ abi: coreAbi, functionName: "transact", args: [proof, pi, noteData[0], noteData[1], noteData[2]] });
}

export function decodeTransact(data: Hex): { proof: Hex; pi: PublicInputs; noteData: [Hex, Hex, Hex] } {
  const d = decodeFunctionData({ abi: coreAbi, data });
  if (d.functionName !== "transact") throw new Error(`not a transact call: ${d.functionName}`);
  const [proof, pi, n0, n1, n2] = d.args as unknown as [Hex, PublicInputs, Hex, Hex, Hex];
  return { proof, pi: Object.fromEntries(PUBLIC_SIGNALS.map((k) => [k, BigInt(pi[k])])) as PublicInputs, noteData: [n0, n1, n2] };
}
