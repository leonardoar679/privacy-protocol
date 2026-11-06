// The prover client over a fake worker (spec v3.0 §7.3; V7 Stage 6): requests numbered and matched to their answers,
// progress delivered to the request that asked, an error answer rejecting that request alone, a worker failure
// rejecting what was sent to it and the next request starting a new worker, a close retiring the worker — it answers
// what was sent to it, then posts close and ends — while later requests go to a fresh one.
import { describe, expect, it, vi } from "vitest";
import { CLOSE_DEFER_MS, CLOSE_WAIT_MS, ProverClient, type WorkerLike } from "../src/prover/client";
import type { ProverEvent, ProverRequest } from "../src/prover/protocol";
import vector from "../vectors/proof.json";

class FakeWorker implements WorkerLike {
  sent: ProverRequest[] = [];
  terminated = false;
  onmessage: ((e: { data: ProverEvent }) => void) | null = null;
  onerror: ((e: { message?: string }) => void) | null = null;
  postMessage(m: ProverRequest) {
    this.sent.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  emit(ev: ProverEvent) {
    this.onmessage?.({ data: ev });
  }
}

const setup = () => {
  const workers: FakeWorker[] = [];
  const client = new ProverClient({
    artifactBase: "/classic/artifacts",
    options: { maxWorkers: 2 },
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
  });
  return { client, workers };
};

describe("the prover client", () => {
  it("warm: posts the request with the artifact base and options, relays progress, resolves the result", async () => {
    const { client, workers } = setup();
    const progress: unknown[] = [];
    const p = client.warm((x) => progress.push(x));
    expect(workers.length).toBe(1);
    const req = workers[0].sent[0];
    expect(req).toEqual({ id: 1, kind: "warm", artifactBase: "/classic/artifacts", options: { maxWorkers: 2 } });
    workers[0].emit({ id: 1, kind: "progress", progress: { step: "artifacts", loaded: 10, total: 20 } });
    workers[0].emit({ id: 1, kind: "progress", progress: { step: "prover" } });
    workers[0].emit({ id: 1, kind: "done", result: { workers: 2, wasmPages: 2000, fromCache: false, artifactsMs: 1, buildMs: 2 } });
    expect(await p).toEqual({ workers: 2, wasmPages: 2000, fromCache: false, artifactsMs: 1, buildMs: 2 });
    expect(progress).toEqual([{ step: "artifacts", loaded: 10, total: 20 }, { step: "prover" }]);
  });

  it("two requests in flight are answered by id, in any order; an error rejects its own request only", async () => {
    const { client, workers } = setup();
    const a = client.prove(vector.input);
    const b = client.verify(vector.proof as `0x${string}`, vector.publicSignals);
    const w = workers[0];
    expect(w.sent.map((m) => [m.id, m.kind])).toEqual([
      [1, "prove"],
      [2, "verify"],
    ]);
    w.emit({ id: 2, kind: "done", result: { verified: true } });
    expect(await b).toBe(true);
    w.emit({ id: 1, kind: "error", message: "the witness's public signals are not the input's six" });
    await expect(a).rejects.toThrow(/public signals/);
    // a stray answer is ignored
    w.emit({ id: 9, kind: "done", result: { verified: false } });
  });

  it("a worker failure rejects everything pending; the next request starts a new worker", async () => {
    const { client, workers } = setup();
    const a = client.warm();
    const b = client.note("tornado-eth-1-1-0x" + "00".repeat(62));
    workers[0].onerror?.({ message: "out of memory" });
    await expect(a).rejects.toThrow(/out of memory/);
    await expect(b).rejects.toThrow(/out of memory/);
    expect(workers[0].terminated).toBe(true);
    const c = client.note("tornado-eth-1-1-0x" + "00".repeat(62));
    expect(workers.length).toBe(2);
    workers[1].emit({ id: 3, kind: "done", result: { ok: false } });
    expect(await c).toEqual({ ok: false });
  });

  it("close with nothing pending posts close and ends the worker on its answer; closing twice is harmless; the next request starts a new worker (the tenth review round, C10-11)", async () => {
    const { client, workers } = setup();
    const a = client.warm();
    workers[0].emit({ id: 1, kind: "done", result: { workers: 1, wasmPages: 1, fromCache: true, artifactsMs: 0, buildMs: 0 } });
    await a;
    client.close();
    const close = workers[0].sent.at(-1)!;
    expect(close.kind).toBe("close");
    expect(workers[0].terminated, "not before the worker's own close ran").toBe(false);
    workers[0].emit({ id: close.id, kind: "done", result: { closed: true } });
    expect(workers[0].terminated).toBe(true);
    client.close();
    expect(workers[0].sent.filter((m) => m.kind === "close")).toHaveLength(1);
    const b = client.note("tornado-eth-1-1-0x" + "00".repeat(62));
    expect(workers.length).toBe(2);
    workers[1].emit({ id: workers[1].sent[0].id, kind: "done", result: { ok: false } });
    expect(await b).toEqual({ ok: false });
  });

  it("close waits for the requests still pending — another pool's tree build finishes first (C10-11); past CLOSE_DEFER_MS they are rejected; a worker that never answers its close is ended after CLOSE_WAIT_MS", async () => {
    vi.useFakeTimers();
    try {
      const { client, workers } = setup();
      const build = client.buildTree("eth-1", []);
      client.close();
      expect(workers[0].sent.map((m) => m.kind)).toEqual(["tree:build"]);
      workers[0].emit({ id: 1, kind: "done", result: { pool: "eth-1", leaves: 0, root: `0x${"00".repeat(32)}` } });
      expect(await build).toMatchObject({ pool: "eth-1" });
      expect(workers[0].sent.at(-1)!.kind).toBe("close");
      expect(workers[0].terminated).toBe(false);
      vi.advanceTimersByTime(CLOSE_WAIT_MS);
      expect(workers[0].terminated, "no answer: ended all the same").toBe(true);
      const hung = client.warm();
      client.close();
      vi.advanceTimersByTime(CLOSE_DEFER_MS);
      await expect(hung).rejects.toThrow(/closed/);
      expect(workers[1].sent.at(-1)!.kind).toBe("close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a request made during a deferred close goes to a fresh worker (the eleventh review round's critique of C11-6): the retired worker still ends once it has answered — a history's tree request never keeps the withdrawal's worker alive — and its deferral refuses nothing of the new one", async () => {
    vi.useFakeTimers();
    try {
      const { client, workers } = setup();
      const root = `0x${"00".repeat(32)}` as const;
      const build = client.buildTree("eth-1", []); // another pool's history is building
      const proof = client.warm(); // the withdrawal's own work
      workers[0].emit({ id: 2, kind: "done", result: { workers: 1, wasmPages: 1, fromCache: true, artifactsMs: 0, buildMs: 0 } });
      await proof;
      client.close(); // the withdrawal ends: the build is still pending
      const layers = client.layersOf("eth-100"); // a history's persist during the deferral
      const started = client.note("tornado-eth-1-1-0x" + "00".repeat(62)); // a withdrawal started within it
      expect(workers).toHaveLength(2);
      expect(
        workers[0].sent.map((m) => m.kind),
        "nothing new reaches the retired worker",
      ).toEqual(["tree:build", "warm"]);
      expect(workers[1].sent.map((m) => m.kind)).toEqual(["tree:layers", "note"]);
      // an answer from the fresh worker is not the retired one's
      let built = false;
      void build.then(() => (built = true));
      workers[1].emit({ id: 1, kind: "done", result: { pool: "eth-1", leaves: 0, root } });
      await Promise.resolve();
      expect(built).toBe(false);
      // past the deferral the build is still waited for, and nothing sent to the fresh worker is refused
      await vi.advanceTimersByTimeAsync(CLOSE_DEFER_MS * 2);
      expect(workers[0].terminated).toBe(false);
      workers[1].emit({ id: 3, kind: "done", result: { pool: "eth-100", layers: [] } });
      workers[1].emit({ id: 4, kind: "done", result: { ok: false } });
      await expect(layers).resolves.toEqual([]);
      await expect(started).resolves.toEqual({ ok: false });
      workers[0].emit({ id: 1, kind: "done", result: { pool: "eth-1", leaves: 0, root } });
      await expect(build).resolves.toMatchObject({ pool: "eth-1" });
      const close = workers[0].sent.at(-1)!;
      expect(close.kind, "the retired worker closes once it has answered").toBe("close");
      workers[0].emit({ id: close.id, kind: "done", result: { closed: true } });
      expect(workers[0].terminated).toBe(true);
      expect(workers[1].terminated).toBe(false);
      expect(workers[1].sent.map((m) => m.kind)).not.toContain("close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a retired worker's failure rejects only what was sent to it; the fresh worker's requests stand (the critique of C11-6)", async () => {
    const { client, workers } = setup();
    const build = client.buildTree("eth-1", []);
    client.close();
    const note = client.note("tornado-eth-1-1-0x" + "00".repeat(62));
    workers[0].onerror?.({ message: "out of memory" });
    await expect(build).rejects.toThrow(/out of memory/);
    expect(workers[0].terminated).toBe(true);
    workers[1].emit({ id: 2, kind: "done", result: { ok: false } });
    await expect(note).resolves.toEqual({ ok: false });
    expect(workers[1].terminated).toBe(false);
    // the fresh worker is still the one requests go to, and the one the next close retires (the critique: a third had been started)
    const again = client.note("tornado-eth-1-1-0x" + "00".repeat(62));
    expect(workers).toHaveLength(2);
    workers[1].emit({ id: 3, kind: "done", result: { ok: false } });
    await again;
    // the crashed worker is gone: a request that loads the prover waits for nothing (it would have waited for good)
    const warm = client.warm();
    await new Promise((r) => setTimeout(r, 0));
    expect(workers[1].sent.map((m) => m.kind)).toEqual(["note", "note", "warm"]);
    workers[1].emit({ id: 4, kind: "done", result: { workers: 1, wasmPages: 1, fromCache: true, artifactsMs: 0, buildMs: 0 } });
    await expect(warm).resolves.toMatchObject({ workers: 1 });
    client.close();
    expect(workers[1].sent.at(-1)!.kind).toBe("close");
  });

  it("a retired worker answers what was sent to it — a note's hashes before CLOSE_DEFER_MS, a tree's append and layers past it — then closes (the critique of C11-6)", async () => {
    vi.useFakeTimers();
    try {
      const { client, workers } = setup();
      const root = `0x${"00".repeat(32)}` as const;
      const note = client.note("tornado-eth-1-1-0x" + "00".repeat(62));
      const append = client.appendLeaves("eth-1", [root]);
      const layers = client.layersOf("eth-1");
      client.close();
      await vi.advanceTimersByTimeAsync(1_000);
      workers[0].emit({ id: 1, kind: "done", result: { ok: false } });
      await expect(note).resolves.toEqual({ ok: false });
      await vi.advanceTimersByTimeAsync(CLOSE_DEFER_MS * 2);
      workers[0].emit({ id: 2, kind: "done", result: { pool: "eth-1", leaves: 1, root } });
      workers[0].emit({ id: 3, kind: "done", result: { pool: "eth-1", layers: [] } });
      await expect(append).resolves.toMatchObject({ leaves: 1 });
      await expect(layers).resolves.toEqual([]);
      expect(workers[0].sent.at(-1)!.kind, "closed once it has answered").toBe("close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a withdrawal's proof — its note() and then its prove() — waits for the retired worker too (the critique)", async () => {
    const { client, workers } = setup();
    const root = `0x${"00".repeat(32)}` as const;
    void client.buildTree("eth-1", []); // id 1: another pool's history, pending when the last withdrawal ended
    client.close();
    const note = client.note("tornado-eth-1-1-0x" + "00".repeat(62)); // id 2
    const proof = client.prove(vector.input); // id 3
    await new Promise((r) => setTimeout(r, 0));
    expect(
      workers[1].sent.map((m) => m.kind),
      "the note at once, the proof not yet",
    ).toEqual(["note"]);
    workers[0].emit({ id: 1, kind: "done", result: { pool: "eth-1", leaves: 0, root } });
    const close = workers[0].sent.at(-1)!;
    workers[0].emit({ id: close.id, kind: "done", result: { closed: true } });
    await new Promise((r) => setTimeout(r, 0));
    expect(workers[1].sent.map((m) => m.kind)).toEqual(["note", "prove"]);
    workers[1].emit({ id: 2, kind: "done", result: { ok: false } });
    workers[1].emit({ id: 3, kind: "done", result: { proof: "0x00", publicSignals: [], verified: true } as never });
    await expect(note).resolves.toEqual({ ok: false });
    await expect(proof).resolves.toMatchObject({ verified: true });
  });

  it("a request that loads the prover waits for every retired worker to be gone: two websnark instances are never alive at once (the critique of the critique of C11-6)", async () => {
    const { client, workers } = setup();
    const WARM = { workers: 1, wasmPages: 1, fromCache: true, artifactsMs: 0, buildMs: 0 };
    const root = `0x${"00".repeat(32)}` as const;
    const first = client.warm(); // id 1: the withdrawal's prover
    workers[0].emit({ id: 1, kind: "done", result: WARM });
    await first;
    const build = client.buildTree("eth-1", []); // id 2: another pool's history
    client.close(); // the withdrawal ends: retired, the build pending
    const note = client.note("tornado-eth-1-1-0x" + "00".repeat(62)); // id 3: needs no prover, goes at once
    const warm = client.warm(); // id 4: waits
    await new Promise((r) => setTimeout(r, 0));
    expect(workers).toHaveLength(2);
    expect(
      workers[1].sent.map((m) => m.kind),
      "the note at once, no prover while the retired one lives",
    ).toEqual(["note"]);
    workers[0].emit({ id: 2, kind: "done", result: { pool: "eth-1", leaves: 0, root } });
    await build;
    const close = workers[0].sent.at(-1)!;
    expect(close.kind).toBe("close");
    workers[0].emit({ id: close.id, kind: "done", result: { closed: true } });
    expect(workers[0].terminated).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(
      workers[1].sent.map((m) => m.kind),
      "the prover once the retired worker is gone",
    ).toEqual(["note", "warm"]);
    workers[1].emit({ id: 3, kind: "done", result: { ok: false } });
    workers[1].emit({ id: 4, kind: "done", result: WARM });
    await expect(note).resolves.toEqual({ ok: false });
    await expect(warm).resolves.toEqual(WARM);
  });

  it("a deferred close waits for a tree build past CLOSE_DEFER_MS and rejects the rest (the eleventh review round's critic: every tree is built from its leaves once)", async () => {
    vi.useFakeTimers();
    try {
      const { client, workers } = setup();
      const build = client.buildTree("eth-100", []);
      const proof = client.warm();
      client.close();
      vi.advanceTimersByTime(CLOSE_DEFER_MS);
      await expect(proof).rejects.toThrow(/closed/);
      const w = workers[0];
      expect(
        w.sent.map((m) => m.kind),
        "the build still runs",
      ).toEqual(["tree:build", "warm"]);
      w.emit({ id: 1, kind: "done", result: { pool: "eth-100", leaves: 0, root: `0x${"00".repeat(32)}` } });
      await expect(build).resolves.toMatchObject({ pool: "eth-100" });
      expect(w.sent.at(-1)!.kind, "closed once the build is answered").toBe("close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a worker that cannot be created rejects the request", async () => {
    const client = new ProverClient({
      artifactBase: "/classic/artifacts",
      createWorker: () => {
        throw new Error("no Worker here");
      },
    });
    await expect(client.warm()).rejects.toThrow(/no Worker here/);
  });
});
