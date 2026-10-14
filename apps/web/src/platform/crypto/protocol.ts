// The crypto worker's messages (V6 Stage 15; spec v2.0 §14.3). The main thread sends a request with an id; the worker
// posts progress while proving and answers once — bytes, a proof, or an error, never a circuit input. Byte arguments
// travel as transferred buffers; a spend plan as a structured clone (bigints included) with its Merkle layers as plain
// arrays (a class instance would lose its methods on the way).
import type { TxSpec } from "@privacy-wallet/protocol/txInputs";
import type { ArtifactPins } from "../../prover/pins";

export type CoreEngine = "wasm" | "typescript";

/** A spend plan as it crosses into the worker: the TxSpec without its MerkleLayers instance, the layers as arrays. */
export type PlanMessage = Omit<TxSpec, "tree"> & { layers?: { levels: number; upper: bigint[][] } };

export interface ArtifactRequest {
  wasmUrl: string;
  zkeyUrl: string;
  verificationKey?: unknown;
  pins?: ArtifactPins;
  production: boolean;
}

export type CryptoRequest =
  | { id: number; op: "layers"; leaves: Uint8Array; levels: number; coreBase: string }
  | {
      id: number;
      op: "scan";
      viewKey: Uint8Array;
      ownerCommitment: Uint8Array;
      leafIndexes: Uint32Array;
      commitments: Uint8Array;
      payloads: Uint8Array;
      coreBase: string;
    }
  | { id: number; op: "prove"; plan: PlanMessage; artifacts: ArtifactRequest };

/** The proof's phases: the key (fetched or read from the cache, and checked), then the inputs, the witness and the proof. */
export type ProvePhase = "key" | "proving";

export type CryptoResponse =
  | { id: number; type: "progress"; phase: ProvePhase }
  | { id: number; type: "bytes"; out: Uint8Array; engine: CoreEngine }
  | {
      id: number;
      type: "proved";
      proof: string;
      publicSignals: string[];
      ms: number;
      keyMs: number;
      proveMs: number;
      keyCached: boolean;
      pins: { zkey: string; wasm: string };
    }
  | { id: number; type: "error"; error: string };

/** The Cache API's store of the pinned artifacts, and the key of one: its name and its pinned SHA-256. */
export const ARTIFACT_CACHE = "privacy-wallet-artifacts-v1";
export const artifactCacheKey = (name: string, sha256: string): string => `/__artifact-cache/${name}/${sha256}`;
