// The main thread's handle on the prover worker (spec v3.0 §7.3): one current worker per client, requests numbered and
// answered in any order, progress per request, errors as rejections. The worker is created at the first request; a close
// retires it — it may still answer what it was sent, beside a fresh one, and a request that loads the prover waits for it
// to be gone — and the next request starts a new one, as after a crash, which rejects what the crashed worker held. The
// tests hand in a fake worker.
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

/** How long a retired worker is given for the requests still pending, and then for its own close (the tenth review round, C10-11). */
export const CLOSE_DEFER_MS = 120_000;
export const CLOSE_WAIT_MS = 5_000;

interface Pending {
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: ProverProgress) => void;
  /** a tree request: a retiring worker answers it first, whatever the deferral (C11-6) */
  build?: boolean;
  /** the worker the request was sent to */
  worker: WorkerLike;
}

export class ProverClient {
  /** the worker new requests go to */
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /**
   * workers a close retired (the eleventh review round's critique of C11-6), each with its deferral: it answers what was sent to it, then ends;
   * nothing new is sent to it
   */
  private readonly retiring = new Map<WorkerLike, ReturnType<typeof setTimeout>>();
  /**
   * every retired worker until it is gone (terminated, or failed): a request that loads the prover waits for them — two websnark instances, each
   * up to 4 × 1,000 WebAssembly pages, had been alive at once on a phone (the critique of the critique of C11-6)
   */
  private readonly gone = new Map<WorkerLike, { promise: Promise<void>; done: () => void }>();

  constructor(private readonly opts: ProverClientOptions) {}

  private track(w: WorkerLike): void {
    let done = (): void => undefined;
    const promise = new Promise<void>((resolve) => (done = resolve));
    this.gone.set(w, { promise, done });
  }

  private release(w: WorkerLike): void {
    this.gone.get(w)?.done();
    this.gone.delete(w);
  }

  private ensure(): WorkerLike {
    if (this.worker) return this.worker;
    const w = (this.opts.createWorker ?? createProverWorker)();
    w.onmessage = (e) => this.receive(w, e.data);
    w.onerror = (e) => this.fail(w, new Error(e.message ?? "the prover worker stopped"));
    this.worker = w;
    return w;
  }

  private pendingOf(w: WorkerLike): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.worker === w) n++;
    return n;
  }

  private receive(w: WorkerLike, ev: ProverEvent) {
    const p = this.pending.get(ev.id);
    if (!p || p.worker !== w) return;
    if (ev.kind === "progress") p.onProgress?.(ev.progress);
    else {
      this.pending.delete(ev.id);
      if (ev.kind === "done") p.resolve(ev.result);
      else p.reject(new Error(ev.message));
      if (this.retiring.has(w) && this.pendingOf(w) === 0) this.end(w);
    }
  }

  private fail(w: WorkerLike, err: Error) {
    for (const [id, p] of this.pending)
      if (p.worker === w) {
        p.reject(err);
        this.pending.delete(id);
      }
    const deferral = this.retiring.get(w);
    if (deferral) clearTimeout(deferral);
    this.retiring.delete(w);
    if (this.worker === w) this.worker = null;
    w.terminate();
    this.release(w);
  }

  private request<T>(make: (id: number) => ProverRequest, onProgress?: (p: ProverProgress) => void): Promise<T> {
    const id = this.nextId++;
    const request = make(id);
    // a request that loads the prover — warm builds websnark, a proof runs it — waits for every retired worker to be gone
    const before = (request.kind === "warm" || request.kind === "prove") && this.gone.size ? [...this.gone.values()].map((g) => g.promise) : null;
    return before ? Promise.all(before).then(() => this.send<T>(id, request, onProgress)) : this.send<T>(id, request, onProgress);
  }

  private send<T>(id: number, request: ProverRequest, onProgress?: (p: ProverProgress) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let w: WorkerLike;
      try {
        w = this.ensure();
      } catch (e) {
        reject(e instanceof Error ? e : new Error("the prover worker could not be started"));
        return;
      }
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, onProgress, build: request.kind.startsWith("tree:"), worker: w });
      try {
        w.postMessage(request);
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
   * Retires the worker that served the withdrawal — its witness and websnark's sub-workers end with it (the fifth round: the prover is closed once
   * the record is terminal) — and sends every later request to a fresh worker (the eleventh review round's critique of C11-6): a request made
   * during a deferred close had cancelled it, and the worker that computed the witness had stayed alive for the page. The retired worker answers
   * what was sent to it first (the tenth review round, C10-11: a close had rejected another pool's tree build, its history then failed): past
   * CLOSE_DEFER_MS what is still pending is refused but a tree request — a build may take a slow phone minutes (C11-2 builds every tree from
   * its leaves once), and a tree request computes, it fetches nothing; then its own close (or CLOSE_WAIT_MS) ends it. The trees it held go with
   * it: a history whose tree is lost loads it again from the device's copy, or builds it from the deposits it holds (history.ts reloadTree)
   */
  close(): void {
    const w = this.worker;
    if (!w) return;
    this.worker = null;
    this.track(w);
    if (this.pendingOf(w) === 0) return this.end(w);
    this.retiring.set(
      w,
      setTimeout(() => {
        for (const [id, p] of this.pending)
          if (p.worker === w && !p.build) {
            p.reject(new Error("the prover was closed"));
            this.pending.delete(id);
          }
        if (this.pendingOf(w) === 0) this.end(w);
      }, CLOSE_DEFER_MS),
    );
  }

  private end(w: WorkerLike): void {
    const deferral = this.retiring.get(w);
    if (deferral) clearTimeout(deferral);
    this.retiring.delete(w);
    for (const [id, p] of this.pending)
      if (p.worker === w) {
        p.reject(new Error("the prover was closed"));
        this.pending.delete(id);
      }
    const id = this.nextId++;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const terminate = () => {
      if (timer) clearTimeout(timer);
      w.terminate();
      this.release(w);
    };
    // the old worker answers only its close now
    w.onmessage = (e) => {
      if (e.data.id === id && e.data.kind !== "progress") terminate();
    };
    w.onerror = terminate;
    try {
      w.postMessage({ id, kind: "close" });
      timer = setTimeout(terminate, CLOSE_WAIT_MS);
    } catch {
      terminate();
    }
  }
}
