// Wallet-side proving (spec §10, §13): a TxSpec becomes the circuit inputs (txInputs.ts), a Groth16
// proof is produced by snarkjs (node or browser build — injected, so this module stays pure), and the
// result is EXACTLY what `PrivacyCore.transact(bytes proof, PublicInputs pi, …)` consumes: the proof
// as abi.encode(uint256[2] a, uint256[2][2] b, uint256[2] c) and the 14 public signals in the
// struct's field order. The e2e forge suite proves the same encoding end to end
// (contracts/test/e2e/RealProofE2E.t.sol); test/prover.test.ts checks this module reproduces its
// public inputs bit for bit.
import { buildTxInputs, type CircuitInputs, type TxSpec } from "./txInputs";

export interface Groth16Proof { pi_a: string[]; pi_b: string[][]; pi_c: string[]; protocol?: string; curve?: string }
/** The subset of snarkjs this module needs; pass `import * as snarkjs from "snarkjs"` (node or browser build). */
export interface SnarkjsLike {
  groth16: {
    fullProve(input: CircuitInputs, wasm: unknown, zkey: unknown): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(vk: unknown, publicSignals: string[], proof: Groth16Proof): Promise<boolean>;
  };
}
/** Where the artifacts are: file paths (node), URLs (browser), or snarkjs `{ type: "mem", data }` objects. */
export interface ProofArtifacts { wasm: unknown; zkey: unknown; verificationKey?: unknown }

/** The circuit's public signals, in order == CoreTypes.PublicInputs field order (RealProofE2E maps p[0..13] positionally). */
export const PUBLIC_SIGNALS = [
  "root", "nullifier0", "nullifier1", "outputBody0", "outputBody1", "outputBody2", "mode",
  "withdrawalVault", "withdrawalAmount", "withdrawalRecipient", "noteData0Hash", "noteData1Hash", "noteData2Hash", "txDomain",
] as const;
export type PublicInputs = Record<(typeof PUBLIC_SIGNALS)[number], bigint>;

export interface TransactCall {
  proof: Uint8Array; // abi.encode(a, b, c): 256 bytes
  publicInputs: PublicInputs;
  publicSignals: bigint[];
  proofJson: Groth16Proof;
}

export function publicInputsFromSignals(signals: (string | bigint)[]): PublicInputs {
  if (signals.length !== PUBLIC_SIGNALS.length) throw new Error(`expected ${PUBLIC_SIGNALS.length} public signals, got ${signals.length}`);
  return Object.fromEntries(PUBLIC_SIGNALS.map((k, i) => [k, BigInt(signals[i])])) as PublicInputs;
}

/** The 14 public signals the inputs declare, in circuit order — used to check the prover's output ordering. */
export function expectedPublicSignals(inputs: CircuitInputs): bigint[] {
  const one = (k: string) => BigInt(inputs[k] as string);
  const arr = (k: string, i: number) => BigInt((inputs[k] as string[])[i]);
  return [
    one("root"), arr("nullifier", 0), arr("nullifier", 1), arr("outputBody", 0), arr("outputBody", 1), arr("outputBody", 2), one("mode"),
    one("withdrawalVault"), one("withdrawalAmount"), one("withdrawalRecipient"), arr("outDataHash", 0), arr("outDataHash", 1), arr("outDataHash", 2), one("txDomain"),
  ];
}

/**
 * The public inputs a spend plan implies, recomputed from the spec (the third review round, 2026-11-03; defence in depth): what the
 * platform's prover — the crypto worker on the web — must answer before anything is signed or sent. A prover that answered another
 * root, nullifier, output body, withdrawal recipient or amount, payload hash or domain is refused on the main thread, which made
 * the plan; before, its answer was taken as the plan's.
 */
export function expectedPublicInputs(spec: TxSpec): PublicInputs {
  return publicInputsFromSignals(expectedPublicSignals(buildTxInputs(spec)));
}

/** Throws, naming the fields that differ, unless `got` is exactly what `spec` implies. */
export function assertPublicInputsOfSpec(got: PublicInputs, spec: TxSpec): void {
  const want = expectedPublicInputs(spec);
  const differ = PUBLIC_SIGNALS.filter((k) => got?.[k] !== want[k]);
  if (differ.length) throw new Error(`the proof's public inputs are not the plan's (${differ.join(", ")}): nothing is sent`);
}

const word = (v: bigint, out: Uint8Array, at: number) => { let x = v; for (let i = 31; i >= 0; i--) { out[at + i] = Number(x & 0xffn); x >>= 8n; } };

/**
 * abi.encode(uint256[2] a, uint256[2][2] b, uint256[2] c) — eight static words. The G2 point's inner
 * coordinate pairs are swapped, exactly as snarkjs' exportSolidityCallData emits them and as the
 * on-chain pairing precompile expects.
 */
export function encodeProof(p: Groth16Proof): Uint8Array {
  const ws = [p.pi_a[0], p.pi_a[1], p.pi_b[0][1], p.pi_b[0][0], p.pi_b[1][1], p.pi_b[1][0], p.pi_c[0], p.pi_c[1]].map(BigInt);
  const out = new Uint8Array(32 * 8);
  ws.forEach((w, i) => word(w, out, i * 32));
  return out;
}

export const bytesToHex0x = (b: Uint8Array): string => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Prove already-built circuit inputs; verifies locally when a verification key is given; checks the public-signal order. */
export async function proveInputs(snarkjs: SnarkjsLike, inputs: CircuitInputs, artifacts: ProofArtifacts): Promise<TransactCall> {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, artifacts.wasm, artifacts.zkey);
  const signals = publicSignals.map(BigInt);
  const expected = expectedPublicSignals(inputs);
  if (signals.length !== expected.length || signals.some((s, i) => s !== expected[i])) throw new Error("prover: public signals do not match the inputs (circuit/struct order mismatch)");
  if (artifacts.verificationKey !== undefined && !(await snarkjs.groth16.verify(artifacts.verificationKey, publicSignals, proof))) throw new Error("prover: the proof does not verify locally");
  return { proof: encodeProof(proof), publicInputs: publicInputsFromSignals(signals), publicSignals: signals, proofJson: proof };
}

/** Build the witness from a TxSpec (with the spec's consistency checks) and prove it. */
export async function proveTransaction(snarkjs: SnarkjsLike, spec: TxSpec, artifacts: ProofArtifacts): Promise<TransactCall> {
  return proveInputs(snarkjs, buildTxInputs(spec), artifacts);
}
