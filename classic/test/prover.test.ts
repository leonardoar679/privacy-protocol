// The prover (spec v3.0 §7.3; V7 Stage 6): the circuit input built from a note and its path is the vector's; the
// recorded proof verifies offline against the key transcoded from the deployed Verifier.sol and a bent input does not;
// the verifier call is laid out as the contract reads it; and — when the artifacts are on this machine — the vendored
// stack proves in Node (websnark over worker_threads), twice over the same key, and every proof verifies.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { keccak256 } from "js-sha3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MerkleTree } from "../src/crypto/tree";
import { parseNote } from "../src/model/notes";
import { defaultOptions, Prover } from "../src/prover/engine";
import { circuitInput, publicInputsOf } from "../src/prover/input";
import { DEPLOYED_KEY, snarkjsKey, unpackProof, verifyOffline } from "../src/prover/offline";
import { VERIFY_PROOF_SELECTOR, verifiedOf, verifyProofCall } from "../src/prover/verify";
import PINS from "../src/prover/artifacts.json";
import notes from "../vectors/notes.json";
import vector from "../vectors/proof.json";

const VERIFIER = "0xce172ce1f20ec0b3728c9965470eaf994a03557a" as const;
const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const ARTIFACTS = join(__dirname, "..", "public", "artifacts");
const haveArtifacts = ["witness.json", "tornadoProvingKey.bin"].every((f) => existsSync(join(ARTIFACTS, f)));
const bend = (inputs: string[], i: number) => inputs.map((x, j) => (j === i ? (BigInt(x) + 1n).toString() : x));

describe("the circuit input", () => {
  it("built from the second note and its path, with the recipient and no relayer, is the vector's", () => {
    const parsed = parseNote(notes.notes[1].note);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const tree = new MerkleTree(notes.tree.leaves.map((l) => BigInt(l)));
    const input = circuitInput(parsed.note, tree.path(1), { root: tree.root, recipient: RECIPIENT, relayer: ZERO_ADDRESS, feeWei: 0n, refundWei: 0n });
    expect(input).toEqual(vector.input);
    expect(publicInputsOf(input)).toEqual(vector.publicSignals);
    expect(input.pathElements.length).toBe(20);
    expect(input.pathIndices).toEqual(notes.tree.path.pathIndices.map(String));
  });
});

describe("the deployed verifier's key and the offline verifier", () => {
  it("the key has six public inputs and seven IC points; snarkjs's form reorders every G2 limb pair", () => {
    expect(DEPLOYED_KEY.nPublic).toBe(6);
    expect(DEPLOYED_KEY.IC.length).toBe(7);
    const vk = snarkjsKey();
    expect(vk.vk_beta_2[0]).toEqual([DEPLOYED_KEY.beta2[0][1], DEPLOYED_KEY.beta2[0][0]]);
    expect(vk.vk_gamma_2[1]).toEqual([DEPLOYED_KEY.gamma2[1][1], DEPLOYED_KEY.gamma2[1][0]]);
    expect(vk.vk_alpha_1).toEqual([DEPLOYED_KEY.alfa1[0], DEPLOYED_KEY.alfa1[1], "1"]);
  });

  it("unpacks the contract's eight words into websnark's A, B (limbs restored) and C", () => {
    const p = unpackProof(vector.proof as `0x${string}`);
    expect(p.pi_a).toEqual([vector.pi.pi_a[0], vector.pi.pi_a[1], "1"]);
    expect(p.pi_b).toEqual([vector.pi.pi_b[0], vector.pi.pi_b[1], ["1", "0"]]);
    expect(p.pi_c).toEqual([vector.pi.pi_c[0], vector.pi.pi_c[1], "1"]);
    expect(() => unpackProof("0x1234")).toThrow(/512 hex/);
  });

  it("the recorded proof verifies; the same proof with any public input bent does not", async () => {
    expect(await verifyOffline(vector.proof as `0x${string}`, vector.publicSignals)).toBe(true);
    for (let i = 0; i < 6; i++) expect(await verifyOffline(vector.proof as `0x${string}`, bend(vector.publicSignals, i)), `input ${i} bent`).toBe(false);
    const bentProof = ("0x" + (BigInt(vector.proof) ^ 1n).toString(16).padStart(512, "0")) as `0x${string}`;
    expect(await verifyOffline(bentProof, vector.publicSignals)).toBe(false);
  }, 120_000);
});

describe("the verifier call", () => {
  it("selector keccak256('verifyProof(bytes,uint256[6])'); the bytes after the offset word and the six inputs; the answer a word", () => {
    expect(VERIFY_PROOF_SELECTOR).toBe("0x" + keccak256("verifyProof(bytes,uint256[6])").slice(0, 8));
    const call = verifyProofCall(VERIFIER, vector.proof as `0x${string}`, vector.publicSignals);
    expect(call.to).toBe(VERIFIER);
    const data = call.data.slice(2);
    expect(data.length).toBe(8 + 64 * 8 + 512);
    expect(data.slice(0, 8)).toBe(VERIFY_PROOF_SELECTOR.slice(2));
    const word = (i: number) => BigInt("0x" + data.slice(8 + 64 * i, 8 + 64 * (i + 1)));
    expect(word(0)).toBe(224n); // 7 words of head
    for (let i = 0; i < 6; i++) expect(word(1 + i)).toBe(BigInt(vector.publicSignals[i]));
    expect(word(7)).toBe(256n); // the proof's length
    expect(data.slice(8 + 64 * 8)).toBe(vector.proof.slice(2));
    expect(verifiedOf("0x" + "0".repeat(63) + "1")).toBe(true);
    expect(verifiedOf("0x" + "0".repeat(64))).toBe(false);
    expect(() => verifiedOf("0x")).toThrow(/not a word/);
    expect(() => verifyProofCall(VERIFIER, "0x12" as `0x${string}`, vector.publicSignals)).toThrow(/512 hex/);
    expect(() => verifyProofCall(VERIFIER, vector.proof as `0x${string}`, ["1"])).toThrow(/six/);
  });
});

describe.skipIf(!haveArtifacts)("proving in Node with the vendored stack (public/artifacts present)", () => {
  let prover: Prover;
  beforeAll(async () => {
    const key = readFileSync(join(ARTIFACTS, "tornadoProvingKey.bin"));
    prover = await Prover.create(
      {
        witness: JSON.parse(readFileSync(join(ARTIFACTS, "witness.json"), "utf8")),
        provingKey: key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength),
      },
      { ...defaultOptions(2), wasmInitialMemory: 2000 },
    );
  }, 120_000);
  afterAll(async () => {
    await prover?.close();
  });

  it("the pins name the artifacts the prover loads", () => {
    expect(Object.keys(PINS.files).sort()).toEqual(["tornado.json", "tornadoProvingKey.bin", "witness.json"]);
  });

  it("the converted witness calculator (queued triggering, no eval) computes the same witness as the pristine snarkjs 0.1.20 (nested triggering, eval)", async () => {
    const require = createRequire(import.meta.url);
    const Pristine = require("../vendor/snarkjs-0.1.20/src/circuit.js");
    const { unstringifyBigInts } = require("../vendor/snarkjs-0.1.20/src/stringifybigint.js");
    const pristine = new Pristine(unstringifyBigInts(JSON.parse(readFileSync(join(ARTIFACTS, "tornado.json"), "utf8"))));
    const theirs: unknown[] = pristine.calculateWitness(unstringifyBigInts(vector.input));
    const { genWitness } = (await import("../src/prover/legacy/websnark-utils.js")) as {
      genWitness: (i: unknown, c: unknown, t: unknown) => { witness: unknown[] };
    };
    const { compiled } = await import("../src/prover/generated/templates.js");
    const ours = genWitness(vector.input, JSON.parse(readFileSync(join(ARTIFACTS, "witness.json"), "utf8")), compiled).witness;
    expect(ours.length).toBe(theirs.length);
    expect(ours.length).toBe(28300);
    for (let i = 0; i < ours.length; i++)
      if (String(ours[i]) !== String(theirs[i])) throw new Error(`witness[${i}] differs: ${String(ours[i])} vs ${String(theirs[i])}`);
  }, 120_000);

  it("proves the vector's input twice (the key survives a proof) and both proofs verify offline; a proof over a bent root does not", async () => {
    expect(prover.workers).toBe(2);
    const first = await prover.prove(vector.input);
    expect(first.proof).toMatch(/^0x[0-9a-f]{512}$/);
    expect(first.publicSignals).toEqual(vector.publicSignals);
    expect(await verifyOffline(first.proof, first.publicSignals)).toBe(true);
    expect(await verifyOffline(first.proof, bend(first.publicSignals, 2))).toBe(false);
    const second = await prover.prove(vector.input);
    expect(second.proof).not.toBe(first.proof); // r and s are fresh
    expect(await verifyOffline(second.proof, second.publicSignals)).toBe(true);
    console.info(
      `PROVER  Node: witness ${Math.round(first.witnessMs)} ms, proof ${Math.round(first.proofMs)} ms (2 workers, 2,000 pages), second proof ${Math.round(second.proofMs)} ms`,
    );
    // a root the path does not prove: the witness calculator refuses (the circuit's root check fails)
    // in a fixed phrase (the fourth review round, 2026-11-03): the calculator's own assert named both sides of the failed constraint
    await expect(prover.prove({ ...vector.input, root: (BigInt(vector.input.root) + 1n).toString() })).rejects.toThrow(
      /^the witness does not satisfy the circuit: the note does not open this path or root$/,
    );
  }, 300_000);
});
