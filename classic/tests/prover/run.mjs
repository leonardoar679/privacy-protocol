#!/usr/bin/env node
// The Classic prover in the real browser (spec v3.0 §7.3; V7 Stage 6; verify-all --browser): the production build served
// by `vite preview` under its own content security policy headers (scripts/csp.mjs), the built prover worker started from
// the page by its URL, the artifacts fetched from /classic/artifacts/ and held to the pins, websnark's sub-workers from
// Blob URLs, the witness and the proof of vectors/proof.json's input, the proof verified offline inside the worker and a
// bent input refused, a note's derivations; then a second page that must find the artifacts in Cache Storage. The
// timings, the worker count and the heaps land in tests/prover/run/report.json (git-ignored). Skips (exit 0) without a
// build or without the artifacts on this machine; fails on anything else.
//   node tests/prover/run.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");
const DIST = join(APP, "dist");
const PORT = Number(process.env.CLASSIC_PROVER_PORT ?? 5199);
const BASE = `http://127.0.0.1:${PORT}/classic`;
const RUN = join(HERE, "run");

const fail = (msg) => {
  console.error(`FAIL  ${msg}`);
  process.exitCode = 1;
};

if (!existsSync(join(DIST, "index.html"))) {
  console.log("SKIP  no dist/ to run (npm run build)");
  process.exit(0);
}
if (!["witness.json", "tornadoProvingKey.bin"].every((f) => existsSync(join(DIST, "artifacts", f)))) {
  console.log("SKIP  the artifacts are not in the build on this machine (scripts/copy-artifacts.mjs, then npm run build)");
  process.exit(0);
}

const pins = JSON.parse(readFileSync(join(APP, "src", "prover", "artifacts.json"), "utf8"));
const vector = JSON.parse(readFileSync(join(APP, "vectors", "proof.json"), "utf8"));
const notes = JSON.parse(readFileSync(join(APP, "vectors", "notes.json"), "utf8"));
// the worker chunk: the one built file carrying websnark's WebAssembly (base64 "\0asm") and the artifact pins
const chunk = readdirSync(join(DIST, "assets")).find((f) => {
  if (!f.endsWith(".js")) return false;
  const text = readFileSync(join(DIST, "assets", f), "utf8");
  return text.includes('"AGFzbQ') && text.includes(pins.files["witness.json"].sha256);
});
if (!chunk) {
  fail("no built chunk carries both websnark's WebAssembly and the artifact pins (the prover worker is not in the build)");
  process.exit(1);
}

async function startPreview() {
  const vite = join(APP, "node_modules", "vite", "bin", "vite.js");
  const p = spawn(process.execPath, [vite, "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: APP,
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  p.stdout.on("data", (d) => (log += d));
  p.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/`);
      if (r.ok) return { p, headers: Object.fromEntries(r.headers.entries()) };
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  p.kill();
  throw new Error(`the preview server did not start on ${BASE}:\n${log}`);
}

const { p: preview, headers } = await startPreview();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const report = { date: new Date().toISOString(), chunk, headers: { csp: headers["content-security-policy"] }, runs: [] };
try {
  const csp = headers["content-security-policy"] ?? "";
  if (!/script-src 'self' 'wasm-unsafe-eval'/.test(csp) || !/worker-src 'self' blob:/.test(csp) || /'unsafe-inline'|'unsafe-eval'/.test(csp))
    fail(`the preview's policy is not the app's: ${csp}`);

  // one browser context for both visits: the second must find the artifacts in the first's Cache Storage
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const drive = async (label, { prove }) => {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("response", (r) => {
      if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
    });
    page.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
    });
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    const result = await page.evaluate(
      async ({ workerUrl, input, artifactBase, bentInputs, note, prove }) => {
        const worker = new Worker(workerUrl, { type: "module" });
        const events = [];
        let nextId = 1;
        const send = (msg) =>
          new Promise((resolve, reject) => {
            const id = nextId++;
            const onMessage = (e) => {
              const ev = e.data;
              if (ev.id !== id) return;
              if (ev.kind === "progress") {
                events.push({ id, ...ev.progress, t: Math.round(performance.now()) });
                return;
              }
              worker.removeEventListener("message", onMessage);
              if (ev.kind === "done") resolve(ev.result);
              else reject(new Error(ev.message));
            };
            worker.addEventListener("message", onMessage);
            worker.addEventListener("error", (e) => reject(new Error(e.message ?? "the worker failed")), { once: true });
            worker.postMessage({ id, ...msg });
          });
        const out = { cores: navigator.hardwareConcurrency, events };
        try {
          const t0 = performance.now();
          out.warm = await send({ kind: "warm", artifactBase });
          out.warmMs = Math.round(performance.now() - t0);
          if (prove) {
            const t1 = performance.now();
            out.proof = await send({ kind: "prove", artifactBase, input });
            out.proveMs = Math.round(performance.now() - t1);
            out.verified = (await send({ kind: "verify", proof: out.proof.proof, publicInputs: out.proof.publicSignals })).verified;
            out.bent = (await send({ kind: "verify", proof: out.proof.proof, publicInputs: bentInputs })).verified;
          }
          out.note = await send({ kind: "note", note });
        } catch (e) {
          // which request failed, with what the worker had reported so far
          out.failed = { after: Object.keys(out).filter((k) => !["cores", "events"].includes(k)), message: e instanceof Error ? e.message : String(e) };
        }
        out.heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
        worker.postMessage({ id: nextId++, kind: "close" });
        return out;
      },
      {
        workerUrl: `/classic/assets/${chunk}`,
        input: vector.input,
        artifactBase: "/classic/artifacts",
        bentInputs: vector.publicSignals.map((x, i) => (i === 2 ? (BigInt(x) + 1n).toString() : x)),
        note: notes.notes[1].note,
        prove,
      },
    );
    await page.close();
    return { label, result, errors };
  };

  const first = await drive("first visit: fetched, proved", { prove: true });
  report.runs.push(first);
  const r = first.result;
  if (r.failed)
    fail(
      `the worker failed after ${r.failed.after.join(", ") || "nothing"}: ${r.failed.message}; progress so far ${JSON.stringify(r.events.map((e) => e.step))}`,
    );
  if (first.errors.length) fail(`page errors: ${first.errors.join(" | ")}`);
  if (!r.warm || r.warm.workers < 1 || r.warm.workers > 4) fail(`websnark started ${r.warm?.workers} sub-workers`);
  if (r.warm?.fromCache) fail("the first visit should have fetched the artifacts, not found them in the cache");
  if (!r.proof || !/^0x[0-9a-f]{512}$/.test(r.proof.proof)) fail("no packed proof came back");
  if (r.proof && r.proof.publicSignals.join(",") !== vector.publicSignals.join(",")) fail("the proof's public signals are not the input's");
  if (!r.proof?.verified) fail("the worker did not verify its own proof");
  if (r.verified !== true) fail("the verify request did not accept the proof");
  if (r.bent !== false) fail("the verify request accepted the proof with the recipient bent");
  if (!r.note?.ok || r.note.commitment !== notes.notes[1].commitment || r.note.nullifierHash !== notes.notes[1].nullifierHash)
    fail("the note's derivations in the worker are not the vector's");
  const steps = r.events.map((e) => e.step);
  for (const s of ["artifacts", "prover", "witness", "proof", "verify"]) if (!steps.includes(s)) fail(`no progress event for the ${s} step`);
  const loaded = r.events.filter((e) => e.step === "artifacts").at(-1);
  const total = pins.files["witness.json"].bytes + pins.files["tornadoProvingKey.bin"].bytes;
  if (!loaded || loaded.loaded !== total || loaded.total !== total) fail(`the artifacts' progress ended at ${loaded?.loaded}/${loaded?.total}, not ${total}`);

  const second = await drive("second visit: from the cache", { prove: false });
  report.runs.push(second);
  if (second.errors.length) fail(`page errors on the second visit: ${second.errors.join(" | ")}`);
  if (!second.result.warm?.fromCache) fail("the second visit should have found the artifacts in Cache Storage");

  mkdirSync(RUN, { recursive: true });
  writeFileSync(join(RUN, "report.json"), JSON.stringify(report, null, 2));
  if (!process.exitCode) {
    const w = r.warm;
    console.log(
      `PASS  prover in Chrome under the app's policy: ${w.workers} sub-workers (${r.cores} cores), ${w.wasmPages} pages each; artifacts ${w.artifactsMs} ms (${(total / 1048576).toFixed(1)} MB), websnark ${w.buildMs} ms, witness ${r.proof.witnessMs} ms, proof ${r.proof.proofMs} ms, offline verify ${r.proof.verifyMs} ms; the proof verified and a bent input refused; the note's derivations equal; the second visit from the cache in ${second.result.warm.artifactsMs} ms; page heap ${r.heap} MB`,
    );
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await browser.close();
  preview.kill();
}
process.exit(process.exitCode ?? 0);
