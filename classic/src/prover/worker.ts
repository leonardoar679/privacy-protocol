// The prover worker (spec v3.0 §7.3): the one place the vendored stack runs in the app. It fetches the pinned artifacts
// (or takes them from the device's cache, re-hashed), builds websnark with its sub-workers, calculates the witness and
// the proof for a withdrawal, verifies the proof offline before answering, and derives a note's commitment and nullifier
// hash on request. snarkjs 0.1 extends BigInt's prototype: that happens here, never on the main thread. An error never
// repeats what it was asked.
import PINS from "./artifacts.json";
import { commitmentOf, nullifierHashOf, toHex32 } from "../crypto/hashes";
import { sha256Hex } from "../crypto/digest";
import { parseNote } from "../model/notes";
import { fetchVerified, type ArtifactPin } from "../net/artifacts";
import { cachedArtifact, forgetArtifact, storeArtifact } from "../storage/artifactCache";
import { defaultOptions, Prover } from "./engine";
import { verifyOffline } from "./offline";
import type { ProverEvent, ProverOptions, ProverRequest, ProverResult, WarmResult } from "./protocol";

interface WorkerScope {
  postMessage(message: ProverEvent): void;
  onmessage: ((e: MessageEvent<ProverRequest>) => void) | null;
  close(): void;
  navigator?: { hardwareConcurrency?: number };
}
const scope = self as unknown as WorkerScope;

const PIN_FILES: Record<string, ArtifactPin> = PINS.files;
const NEEDED = ["witness.json", "tornadoProvingKey.bin"] as const;
const now = () => performance.now();

let ready: Promise<{ prover: Prover; warm: WarmResult }> | null = null;

const post = (e: ProverEvent) => scope.postMessage(e);

async function loadArtifact(base: string, name: string, report: (loaded: number) => void): Promise<{ bytes: Uint8Array; fromCache: boolean }> {
  const pin = PIN_FILES[name];
  if (!pin) throw new Error(`${name} is not pinned`);
  const url = `${base.replace(/\/+$/, "")}/${name}`;
  const cached = await cachedArtifact(url, pin.sha256);
  if (cached && cached.length === pin.bytes && (await sha256Hex(cached)) === pin.sha256) {
    report(pin.bytes);
    return { bytes: cached, fromCache: true };
  }
  if (cached) await forgetArtifact(url, pin.sha256);
  const bytes = await fetchVerified(url, pin, (loaded) => report(loaded));
  await storeArtifact(url, pin.sha256, bytes);
  return { bytes, fromCache: false };
}

function warmUp(id: number, base: string, options: Partial<ProverOptions> | undefined): Promise<{ prover: Prover; warm: WarmResult }> {
  if (ready) return ready;
  const run = (async () => {
    const total = NEEDED.reduce((n, name) => n + (PIN_FILES[name]?.bytes ?? 0), 0);
    const loaded: Record<string, number> = {};
    const t0 = now();
    const files = await Promise.all(
      NEEDED.map((name) =>
        loadArtifact(base, name, (n) => {
          loaded[name] = n;
          post({ id, kind: "progress", progress: { step: "artifacts", loaded: Object.values(loaded).reduce((a, b) => a + b, 0), total } });
        }),
      ),
    );
    const artifactsMs = now() - t0;
    post({ id, kind: "progress", progress: { step: "prover" } });
    const t1 = now();
    const opts = { ...defaultOptions(scope.navigator?.hardwareConcurrency ?? 2), ...options };
    const key = files[1].bytes;
    const prover = await Prover.create(
      {
        witness: JSON.parse(new TextDecoder().decode(files[0].bytes)),
        provingKey: key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer,
      },
      opts,
    );
    const warm: WarmResult = {
      workers: prover.workers,
      wasmPages: opts.wasmInitialMemory,
      fromCache: files.every((f) => f.fromCache),
      artifactsMs: Math.round(artifactsMs),
      buildMs: Math.round(now() - t1),
    };
    return { prover, warm };
  })();
  ready = run;
  run.catch(() => {
    if (ready === run) ready = null; // the next request tries again
  });
  return run;
}

async function handle(req: ProverRequest): Promise<ProverResult | null> {
  switch (req.kind) {
    case "warm":
      return (await warmUp(req.id, req.artifactBase, req.options)).warm;
    case "prove": {
      const { prover } = await warmUp(req.id, req.artifactBase, req.options);
      post({ id: req.id, kind: "progress", progress: { step: "witness" } });
      const proof = await prover.prove(req.input, () => post({ id: req.id, kind: "progress", progress: { step: "proof" } }));
      post({ id: req.id, kind: "progress", progress: { step: "verify" } });
      const t0 = now();
      const verified = await verifyOffline(proof.proof, proof.publicSignals);
      return {
        proof: proof.proof,
        publicSignals: proof.publicSignals,
        verified,
        witnessMs: Math.round(proof.witnessMs),
        proofMs: Math.round(proof.proofMs),
        verifyMs: Math.round(now() - t0),
      };
    }
    case "verify":
      return { verified: await verifyOffline(req.proof, req.publicInputs) };
    case "note": {
      const parsed = parseNote(req.note);
      if (!parsed.ok) return { ok: false };
      const { currency, amount, netId } = parsed.note;
      return { ok: true, currency, amount, netId, commitment: toHex32(commitmentOf(parsed.note)), nullifierHash: toHex32(nullifierHashOf(parsed.note)) };
    }
    case "close": {
      const r = ready;
      ready = null;
      if (r) await (await r.catch(() => null))?.prover.close();
      scope.close();
      return null;
    }
  }
}

scope.onmessage = (e: MessageEvent<ProverRequest>) => {
  const req = e.data;
  handle(req).then(
    (result) => {
      if (result) post({ id: req.id, kind: "done", result });
    },
    (err: unknown) => post({ id: req.id, kind: "error", message: err instanceof Error ? err.message : "the prover failed" }),
  );
};
