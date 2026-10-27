// The prover as the services want it, in this Node process (V7 Stage 10): the vendored engine over the artifacts under
// public/artifacts (the pins' files), the offline verifier, a note's hashes, and the worker's tree protocol over a real
// MerkleTree here — what the browser's prover worker does, without a worker. For the fork suite and any test that proves
// for real; `prover.test.ts` measures the same engine.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commitmentOf, nullifierHashOf, toHex32 } from "../../src/crypto/hashes";
import { parseNote } from "../../src/model/notes";
import { defaultOptions, Prover } from "../../src/prover/engine";
import type { CircuitInput } from "../../src/prover/input";
import { verifyOffline } from "../../src/prover/offline";
import type { NoteResult, ProofResult, ProverProgress, WarmResult } from "../../src/prover/protocol";
import type { ProverLike } from "../../src/app/services/source";
import { fakeTrees } from "./fakes";

export const ARTIFACTS_DIR = join(__dirname, "..", "..", "public", "artifacts");

export interface NodeProver extends ProverLike {
  close(): Promise<void>;
  proofs: CircuitInput[];
}

/** The engine built once (websnark's sub-workers in this process), proving for real. */
export async function nodeProver(workers = 2): Promise<NodeProver> {
  const key = readFileSync(join(ARTIFACTS_DIR, "tornadoProvingKey.bin"));
  const engine = await Prover.create(
    {
      witness: JSON.parse(readFileSync(join(ARTIFACTS_DIR, "witness.json"), "utf8")),
      provingKey: key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength),
    },
    { ...defaultOptions(workers), wasmInitialMemory: 2000 },
  );
  const trees = fakeTrees();
  const proofs: CircuitInput[] = [];
  return {
    proofs,
    async warm(): Promise<WarmResult> {
      return { workers: engine.workers, wasmPages: 2000, fromCache: false, artifactsMs: 0, buildMs: 0 };
    },
    async prove(input: CircuitInput, onProgress?: (p: ProverProgress) => void): Promise<ProofResult> {
      proofs.push(input);
      onProgress?.({ step: "witness" });
      const proof = await engine.prove(input, () => onProgress?.({ step: "proof" }));
      onProgress?.({ step: "verify" });
      const t0 = Date.now();
      const verified = await verifyOffline(proof.proof, proof.publicSignals);
      return {
        proof: proof.proof,
        publicSignals: proof.publicSignals,
        verified,
        witnessMs: proof.witnessMs,
        proofMs: proof.proofMs,
        verifyMs: Date.now() - t0,
      };
    },
    async verify(proof: `0x${string}`, publicSignals: string[]): Promise<boolean> {
      return verifyOffline(proof, publicSignals);
    },
    async note(text: string): Promise<NoteResult> {
      const parsed = parseNote(text);
      if (!parsed.ok) return { ok: false };
      return {
        ok: true,
        currency: parsed.note.currency,
        amount: parsed.note.amount,
        netId: parsed.note.netId,
        commitment: toHex32(commitmentOf(parsed.note)),
        nullifierHash: toHex32(nullifierHashOf(parsed.note)),
      };
    },
    ...trees.client,
    async close() {
      await engine.close();
    },
  };
}
