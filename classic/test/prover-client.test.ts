// The prover client over a fake worker (spec v3.0 §7.3; V7 Stage 6): requests numbered and matched to their answers,
// progress delivered to the request that asked, an error answer rejecting that request alone, a worker failure
// rejecting everything pending and the next request starting a new worker, close posting close.
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
