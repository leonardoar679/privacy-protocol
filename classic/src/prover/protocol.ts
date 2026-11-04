// The prover worker's protocol (spec v3.0 §7.3): what the screens ask of the dedicated worker that runs the vendored
// stack — warm up (fetch and verify the artifacts, build websnark), prove a withdrawal, verify a proof offline, derive a
// note's commitment and nullifier hash — and what comes back: progress by step, the result, or an error that never
// repeats an input. A note crosses this boundary in memory only, never a URL, a log or a store.
import type { CircuitInput } from "./input";

/** A tree whose path does not fold to its root (the fifth review round, 2026-11-03): the history rebuilds it from the deposits. */
export const TREE_INCONSISTENT = "the tree on the device is not consistent: its path does not hash to its root";

export type ProverStep = "artifacts" | "prover" | "witness" | "proof" | "verify";

/** websnark's knobs: how many sub-workers it spawns and how many 64 KB WebAssembly pages each reserves. */
export interface ProverOptions {
  maxWorkers: number;
  wasmInitialMemory: number;
}

export type ProverRequest =
  | { id: number; kind: "warm"; artifactBase: string; options?: Partial<ProverOptions> }
  | { id: number; kind: "prove"; artifactBase: string; input: CircuitInput; options?: Partial<ProverOptions> }
  | { id: number; kind: "verify"; proof: `0x${string}`; publicInputs: string[] }
  | { id: number; kind: "note"; note: string }
  // the pools' trees live here too (spec §7.4): loaded from persisted layers, built from leaves, appended, asked for a path
  | { id: number; kind: "tree:load"; pool: string; layers: string[][] }
  | { id: number; kind: "tree:build"; pool: string; leaves: string[] }
  | { id: number; kind: "tree:append"; pool: string; leaves: string[] }
  | { id: number; kind: "tree:truncate"; pool: string; leaves: number }
  | { id: number; kind: "tree:path"; pool: string; index: number }
  | { id: number; kind: "tree:layers"; pool: string }
  | { id: number; kind: "close" };

export interface ProverProgress {
  step: ProverStep | "tree";
  /** bytes so far and in all while the artifacts load; leaves so far and in all while a tree is built */
  loaded?: number;
  total?: number;
}

export interface TreeResult {
  pool: string;
  leaves: number;
  root: `0x${string}`;
}

export interface PathResult extends TreeResult {
  pathElements: `0x${string}`[];
  pathIndices: number[];
}

export interface LayersResult {
  pool: string;
  layers: string[][];
}

export interface WarmResult {
  workers: number;
  wasmPages: number;
  /** the artifacts came from the device's cache, not the network */
  fromCache: boolean;
  artifactsMs: number;
  buildMs: number;
}

export interface ProofResult {
  /** the proof as the contract reads it: 0x and eight 32-byte words */
  proof: `0x${string}`;
  /** root, nullifierHash, recipient, relayer, fee, refund — decimal strings */
  publicSignals: string[];
  /** verified offline against the deployed verifier's key before it was returned */
  verified: boolean;
  witnessMs: number;
  proofMs: number;
  verifyMs: number;
}

export interface VerifyResult {
  verified: boolean;
}

export type NoteResult = { ok: true; currency: string; amount: string; netId: number; commitment: `0x${string}`; nullifierHash: `0x${string}` } | { ok: false };

/** The worker's answer to close, sent before its scope ends (the client terminates it then). */
export interface ClosedResult {
  closed: true;
}

export type ProverResult = WarmResult | ProofResult | VerifyResult | NoteResult | TreeResult | PathResult | LayersResult | ClosedResult;

export type ProverEvent =
  | { id: number; kind: "progress"; progress: ProverProgress }
  | { id: number; kind: "done"; result: ProverResult }
  | { id: number; kind: "error"; message: string };
