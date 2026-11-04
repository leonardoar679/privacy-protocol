// Fetching a served snapshot (spec v3.0 §7.4; V7 Stage 10): the four files as text, none when the host answers 404 — or a
// page where the manifest should be, a dev server's fallback (the local stack found the Classic dev server's index.html
// taken for a manifest) —, an error for any other answer, the texts untouched for snapshot.ts to hold to the manifest.
import { describe, expect, it } from "vitest";
import { fetchSnapshot, SnapshotFetchError } from "../src/net/snapshot";

const answer = (status: number, body: string, type = "application/json") => new Response(body, { status, headers: { "content-type": type } });

function host(files: Record<string, Response | (() => Response)>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const name = url.split("/").at(-1) ?? "";
    const r = files[name];
    return r ? (typeof r === "function" ? r() : r.clone()) : answer(404, "not here", "text/plain");
  }) as typeof fetch;
  return { fetchImpl, asked };
}

describe("fetchSnapshot", () => {
  it("returns the manifest and the three files as text from under the base and the pool", async () => {
    const h = host({
      "manifest.json": answer(200, '{"version":1}'),
      "deposits.json": answer(200, "[1]"),
      "withdrawals.json": answer(200, "[2]"),
      "tree.json": answer(200, '{"layers":[]}'),
    });
    const snap = await fetchSnapshot("/classic/data/", "eth-100", h.fetchImpl);
    expect(snap?.manifest).toEqual({ version: 1 });
    expect(snap?.texts["deposits.json"]).toBe("[1]");
    expect(h.asked[0]).toBe("/classic/data/eth-100/manifest.json");
    expect(h.asked.length).toBe(4);
  });
  it("answers null when the host serves none: a 404, or a page where the manifest should be (a dev server's fallback)", async () => {
    expect(await fetchSnapshot("/classic/data", "eth-1", host({}).fetchImpl)).toBeNull();
    const page = host({ "manifest.json": () => answer(200, "<!doctype html><html><body>the app</body></html>", "text/html; charset=utf-8") });
    expect(await fetchSnapshot("/classic/data", "eth-1", page.fetchImpl)).toBeNull();
    expect(page.asked.length).toBe(1);
  });
  it("refuses a file larger than a snapshot file may be, by its length header or while it streams (the tenth review round, C10-15)", async () => {
    const caps = { file: 32, manifest: 1024 };
    const files = (deposits: () => Response) => ({
      "manifest.json": answer(200, '{"version":1}'),
      "deposits.json": deposits,
      "withdrawals.json": answer(200, "[]"),
      "tree.json": answer(200, "{}"),
    });
    const declared = host(files(() => new Response("x".repeat(64), { status: 200, headers: { "content-type": "application/json", "content-length": "64" } })));
    await expect(fetchSnapshot("/d", "eth-1", declared.fetchImpl, 60_000, caps)).rejects.toThrow(/more than a snapshot file may be/);
    const streamed = host(
      files(
        () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("y".repeat(40)));
                c.close();
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    await expect(fetchSnapshot("/d", "eth-1", streamed.fetchImpl, 60_000, caps)).rejects.toThrow(/more than a snapshot file may be/);
    const small = await fetchSnapshot("/d", "eth-1", host(files(() => answer(200, "[1]"))).fetchImpl, 60_000, caps);
    expect(small?.texts["deposits.json"]).toBe("[1]");
  });

  it("names any other answer: a 500, a manifest that is not JSON, a missing file beside a manifest", async () => {
    await expect(fetchSnapshot("/d", "eth-1", host({ "manifest.json": () => answer(500, "no") }).fetchImpl)).rejects.toBeInstanceOf(SnapshotFetchError);
    await expect(fetchSnapshot("/d", "eth-1", host({ "manifest.json": () => answer(200, "{not json") }).fetchImpl)).rejects.toThrow(/not JSON/);
    await expect(fetchSnapshot("/d", "eth-1", host({ "manifest.json": () => answer(200, "{}") }).fetchImpl)).rejects.toThrow(/missing/);
  });
});
