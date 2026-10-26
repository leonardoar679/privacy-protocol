// The main thread's handle on the prover worker (spec v3.0 §7.3): one worker per client, requests numbered and answered
// in any order, progress per request, errors as rejections. The worker is created at the first request and can be
// closed; a crashed worker rejects everything pending and the next request starts a new one. The tests hand in a fake
// worker.
import type { NoteResult, ProofResult, ProverEvent, ProverOptions, ProverProgress, ProverRequest, VerifyResult, WarmResult } from "./protocol";
import type { CircuitInput } from "./input";

export interface WorkerLike {
  postMessage(message: ProverRequest): void;
  onmessage: ((e: { data: ProverEvent }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
  terminate(): void;
}

export interface ProverClientOptions {
  /** where the artifacts are served (config().artifactBase) */
  artifactBase: string;
  /** websnark's knobs for this device; the worker's defaults otherwise */
  options?: Partial<ProverOptions>;
  createWorker?: () => WorkerLike;
}

/** Vite bundles the worker as its own chunk: nothing of the prover loads before the first request. */
export const createProverWorker = (): WorkerLike =>
  new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "tornado-classic-prover" }) as unknown as WorkerLike;

interface Pending {
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: ProverProgress) => void;
}

export class ProverClient {
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly opts: ProverClientOptions) {}

  private ensure(): WorkerLike {
    if (this.worker) return this.worker;
    const w = (this.opts.createWorker ?? createProverWorker)();
    w.onmessage = (e) => this.receive(e.data);
    w.onerror = (e) => this.fail(new Error(e.message ?? "the prover worker stopped"));
    this.worker = w;
    return w;
  }

  private receive(ev: ProverEvent) {
    const p = this.pending.get(ev.id);
    if (!p) return;
    if (ev.kind === "progress") p.onProgress?.(ev.progress);
    else {
      this.pending.delete(ev.id);
      if (ev.kind === "done") p.resolve(ev.result);
      else p.reject(new Error(ev.message));
    }
  }

  private fail(err: Error) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  private request<T>(make: (id: number) => ProverRequest, onProgress?: (p: ProverProgress) => void): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, onProgress });
      try {
        this.ensure().postMessage(make(id));
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error("the prover worker could not be started"));
      }
    });
  }

  /** Fetches and verifies the artifacts and builds websnark, so that a later proof starts at once. */
  warm(onProgress?: (p: ProverProgress) => void): Promise<WarmResult> {
    return this.request<WarmResult>((id) => ({ id, kind: "warm", artifactBase: this.opts.artifactBase, options: this.opts.options }), onProgress);
  }

  prove(input: CircuitInput, onProgress?: (p: ProverProgress) => void): Promise<ProofResult> {
    return this.request<ProofResult>((id) => ({ id, kind: "prove", artifactBase: this.opts.artifactBase, input, options: this.opts.options }), onProgress);
  }

  verify(proof: `0x${string}`, publicInputs: string[]): Promise<boolean> {
    return this.request<VerifyResult>((id) => ({ id, kind: "verify", proof, publicInputs })).then((r) => r.verified);
  }

  /** A note's commitment and nullifier hash, derived in the worker (the note stays in memory). */
  note(note: string): Promise<NoteResult> {
    return this.request<NoteResult>((id) => ({ id, kind: "note", note }));
  }

  /** Stops the worker and its sub-workers; pending requests are rejected. */
  close(): void {
    if (!this.worker) return;
    try {
      this.worker.postMessage({ id: this.nextId++, kind: "close" });
    } catch {
      // already gone
    }
    this.fail(new Error("the prover was closed"));
  }
}
