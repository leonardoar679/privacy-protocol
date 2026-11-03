// The prover (spec v3.0 §7.3): the original's pipeline over the vendored stack — snarkjs 0.1's witness calculator on
// the precompiled circuit, websnark's Groth16 over the original proving key — packed as the contract reads it. Runs
// where it is created: the dedicated worker in the app (worker.ts), the test process in Node. It loads nothing itself:
// the caller hands it the pinned artifacts (witness.json parsed, the proving key's bytes).
import buildGroth16 from "./legacy/groth16.js";
import { stringifyBigInts } from "./legacy/stringifybigint.js";
import { convertWitness, genWitness, toSolidityInput } from "./legacy/websnark-utils.js";
import { compiled } from "./generated/templates.js";
import { publicInputsOf, type CircuitInput } from "./input";
import type { ProverOptions } from "./protocol";

export interface ProverArtifacts {
  /** public/artifacts/witness.json, parsed: the circuit without its constraints */
  witness: unknown;
  /** public/artifacts/tornadoProvingKey.bin */
  provingKey: ArrayBuffer;
}

interface Groth16 {
  workers: { terminate?: () => unknown }[];
  proof(signals: ArrayBuffer, provingKey: ArrayBuffer): Promise<RawProof>;
  terminate(): void;
}

interface RawProof {
  pi_a: unknown[];
  pi_b: unknown[][];
  pi_c: unknown[];
  publicSignals?: unknown;
}

export interface Proof {
  proof: `0x${string}`;
  publicSignals: string[];
  witnessMs: number;
  proofMs: number;
}

/** websnark's defaults for this device: up to four sub-workers, 2,000 pages (125 MB) of WebAssembly memory each. */
export const defaultOptions = (cores: number): ProverOptions => ({ maxWorkers: Math.max(1, Math.min(cores || 1, 4)), wasmInitialMemory: 2000 });

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class Prover {
  private constructor(
    private readonly groth16: Groth16,
    private readonly artifacts: ProverArtifacts,
    readonly options: ProverOptions,
  ) {}

  /** Builds websnark (its WebAssembly, its sub-workers) over the artifacts. */
  static async create(artifacts: ProverArtifacts, options: ProverOptions): Promise<Prover> {
    const groth16 = await (buildGroth16 as unknown as (p: ProverOptions) => Promise<Groth16>)(options);
    return new Prover(groth16, artifacts, options);
  }

  get workers(): number {
    return this.groth16.workers.length;
  }

  /** The witness, then the proof; the public signals checked against the input's six. `onProof` fires when the witness is done. */
  async prove(input: CircuitInput, onProof?: () => void): Promise<Proof> {
    const t0 = now();
    let witness: { witness: unknown[]; publicSignals: unknown[] };
    try {
      witness = genWitness(input, this.artifacts.witness, compiled) as { witness: unknown[]; publicSignals: unknown[] };
    } catch {
      // the calculator's assert names both sides of the failed constraint — tree nodes, bits, in principle a private input: a fixed
      // phrase instead (the fourth review round, 2026-11-03), since the words reach the record on the device
      throw new Error("the witness does not satisfy the circuit: the note does not open this path or root");
    }
    const witnessMs = now() - t0;
    const publicSignals = witness.publicSignals.map((x) => String(x));
    if (publicSignals.join(",") !== publicInputsOf(input).join(",")) throw new Error("the witness's public signals are not the input's six");
    onProof?.();
    const t1 = now();
    const raw = await this.groth16.proof(convertWitness(witness.witness), this.artifacts.provingKey);
    const proofMs = now() - t1;
    raw.publicSignals = stringifyBigInts(witness.publicSignals);
    const packed = (toSolidityInput(raw) as { proof: string }).proof;
    if (!/^0x[0-9a-f]{512}$/.test(packed)) throw new Error("the packed proof is not eight words");
    return { proof: packed as `0x${string}`, publicSignals, witnessMs, proofMs };
  }

  /** Stops the sub-workers (and waits for Node's to end). */
  async close(): Promise<void> {
    this.groth16.terminate();
    await Promise.all(this.groth16.workers.map((w) => (typeof w.terminate === "function" ? Promise.resolve(w.terminate()).catch(() => undefined) : undefined)));
  }
}
