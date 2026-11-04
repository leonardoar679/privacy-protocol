// The main thread's handle on the prover worker (spec v3.0 §7.3): one worker per client, requests numbered and answered
// in any order, progress per request, errors as rejections. The worker is created at the first request and can be
// closed; a crashed worker rejects everything pending and the next request starts a new one. The tests hand in a fake
// worker.
import type {
  LayersResult,
  NoteResult,
  PathResult,
  ProofResult,
  ProverEvent,
  ProverOptions,
  ProverProgress,
  ProverRequest,
  TreeResult,
  VerifyResult,
  WarmResult,
} from "./protocol";
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

/** How long a close waits for the requests still pending, and then for the worker's own close (the tenth review round, C10-11). */
export const CLOSE_DEFER_MS = 120_000;
export const CLOSE_WAIT_MS = 5_000;

interface Pending {
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: ProverProgress) => void;
}

export class ProverClient {
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

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
      if (this.closeTimer && this.pending.size === 0) this.closeNow();
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

  /** A pool's tree from persisted layers (no hashing). */
  loadTree(pool: string, layers: string[][]): Promise<TreeResult> {
    return this.request<TreeResult>((id) => ({ id, kind: "tree:load", pool, layers }));
  }

  /** A pool's tree from its leaves (about 2n hashes; a minute for 50,000 leaves). */
  buildTree(pool: string, leaves: string[], onProgress?: (p: ProverProgress) => void): Promise<TreeResult> {
    return this.request<TreeResult>((id) => ({ id, kind: "tree:build", pool, leaves }), onProgress);
  }

  appendLeaves(pool: string, leaves: string[]): Promise<TreeResult> {
    return this.request<TreeResult>((id) => ({ id, kind: "tree:append", pool, leaves }));
  }

  /** The tree cut back to its first `leaves` leaves (a rollback after a reorg). */
  truncateTree(pool: string, leaves: number): Promise<TreeResult> {
    return this.request<TreeResult>((id) => ({ id, kind: "tree:truncate", pool, leaves }));
  }

  pathOf(pool: string, index: number): Promise<PathResult> {
    return this.request<PathResult>((id) => ({ id, kind: "tree:path", pool, index }));
  }

  /** The layers to persist. */
  layersOf(pool: string): Promise<string[][]> {
    return this.request<LayersResult>((id) => ({ id, kind: "tree:layers", pool })).then((r) => r.layers);
  }

  /**
   * Stops the worker and its sub-workers once the requests still pending are answered (the tenth review round, C10-11): a close after a
   * withdrawal had rejected another pool's tree build — its history then failed, and its notes read "invalid" — and terminated the worker
   * in the same call that posted close, so the worker's own close never ran. Pending requests get CLOSE_DEFER_MS, then are rejected; the
   * worker's answer to close (or CLOSE_WAIT_MS) ends it. A request made meanwhile goes to this worker and is waited for too.
   */
  close(): void {
    if (!this.worker || this.closeTimer) return;
    if (this.pending.size === 0) return this.closeNow();
    this.closeTimer = setTimeout(() => this.closeNow(), CLOSE_DEFER_MS);
  }

  private closeNow(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    const w = this.worker;
    if (!w) return;
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error("the prover was closed"));
    this.pending.clear();
    const id = this.nextId++;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const end = () => {
      if (timer) clearTimeout(timer);
      w.terminate();
    };
    // the old worker answers only its close now; a later request starts a new worker
    w.onmessage = (e) => {
      if (e.data.id === id && e.data.kind !== "progress") end();
    };
    w.onerror = end;
    try {
      w.postMessage({ id, kind: "close" });
      timer = setTimeout(end, CLOSE_WAIT_MS);
    } catch {
      end();
    }
  }
}
