// Wallet-side proving against the real circuit artifacts (circuits/build + the dev setup). Skipped
// when the artifacts are not built. Two checks: (1) the module reproduces the forge-verified e2e
// transaction's public inputs bit for bit from its witness (circuits/test/fixtures/e2e/tx3.json —
// the note that exits to a swap-order escrow) and encodes the proof exactly like snarkjs'
// Solidity calldata; (2) a withdrawal with change built from scratch proves and verifies.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { utf8ToBytes } from "@noble/hashes/utils";
import { encodeProof, expectedPublicSignals, proveInputs, proveTransaction, publicInputsFromSignals, PUBLIC_SIGNALS } from "../src/prover";
import { deriveKeys, deriveNoteSecret } from "../src/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "../src/note";
import { nullifier } from "../src/nullifier";
import { MerkleTree } from "../src/merkle";
import { noteDataHash, testNoteData, txDomain } from "../src/payload";
import { TX_LEVELS, dummyOutput, type SpendNote } from "../src/txInputs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const wasm = join(root, "circuits/build/transaction_js/transaction.wasm");
const zkey = join(root, "circuits/build/setup/transaction_final.zkey");
const vkPath = join(root, "circuits/setup/dev/verification_key.json");
const snarkjsPath = join(root, "circuits/node_modules/snarkjs/build/main.cjs");
const have = [wasm, zkey, vkPath, snarkjsPath].every(existsSync);
const require = createRequire(import.meta.url);
const snarkjs = have ? require(snarkjsPath) : null;
const vk = have ? JSON.parse(readFileSync(vkPath, "utf8")) : null;
const hexWords = (b: Uint8Array) => Array.from({ length: b.length / 32 }, (_, i) => BigInt("0x" + Buffer.from(b.subarray(i * 32, i * 32 + 32)).toString("hex")));

describe.skipIf(!have)("wallet-side prover (real artifacts, dev setup)", () => {
  it("reproduces the forge-verified e2e exit-to-escrow public inputs and snarkjs' calldata layout", async () => {
    const inputs = JSON.parse(readFileSync(join(root, "circuits/test/fixtures/e2e/tx3.json"), "utf8"));
    const meta = JSON.parse(readFileSync(join(root, "circuits/test/fixtures/e2e/meta.json"), "utf8"));
    const call = await proveInputs(snarkjs, inputs, { wasm, zkey, verificationKey: vk });
    // the fixture the forge e2e suite verified on-chain (E2EFixture.pub(2))
    const sol = readFileSync(join(root, "contracts/test/e2e/E2EFixture.sol"), "utf8");
    const m = sol.match(/if \(t == 2\) \{\s*p = \[uint256\(([^)]+)\),([^\]]+)\];/);
    expect(m, "E2EFixture.sol has no pub(2) branch").toBeTruthy();
    const pub = [m![1], ...m![2].split(",")].map((s) => BigInt(s.trim()));
    expect(call.publicSignals).toEqual(pub);
    expect(call.publicInputs.withdrawalRecipient).toBe(BigInt(meta.escrow));
    expect(call.publicInputs.withdrawalAmount).toBe(BigInt(meta.swapAmount));
    expect(call.publicInputs.mode).toBe(1n);
    expect(call.publicInputs.txDomain).toBe(txDomain(31337n, BigInt(JSON.parse(readFileSync(join(root, "contracts/test/e2e/deployment.json"), "utf8")).core)));
    // proof encoding == abi.encode(a, b, c) as the verifier decodes it, with snarkjs' G2 coordinate order
    expect(call.proof.length).toBe(256);
    const [a, b, c] = JSON.parse(`[${await snarkjs.groth16.exportSolidityCallData(call.proofJson, call.publicSignals.map(String))}]`);
    expect(hexWords(call.proof)).toEqual([a[0], a[1], b[0][0], b[0][1], b[1][0], b[1][1], c[0], c[1]].map(BigInt));
    expect(hexWords(encodeProof(call.proofJson))).toEqual(hexWords(call.proof));
    expect(Object.keys(call.publicInputs)).toEqual([...PUBLIC_SIGNALS]);
  }, 180_000);

  it("proves a withdrawal with change built from scratch and verifies it", async () => {
    const keys = deriveKeys(utf8ToBytes("prover-test-seed"));
    const oc = ownerCommitmentOf(keys.spendKey);
    const vault = 0x1234n, core = 0xc0ffeen, chainId = 31337n;
    const deposit: SpendNote = { spendKey: keys.spendKey, ownerCommitment: oc, vaultId: vault, amount: 10n ** 18n, noteSecret: deriveNoteSecret(keys.noteKey, 0), leafIndex: 0 };
    const tree = new MerkleTree(TX_LEVELS);
    tree.insertLeaf(noteCommitment(noteBody(deposit), 0n));
    let ctr = 100;
    const rnd = () => deriveNoteSecret(keys.noteKey, ctr++);
    const change: Note = { vaultId: vault, amount: 6n * 10n ** 17n, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, 1) };
    const payloads = [testNoteData(1n), testNoteData(2n), testNoteData(3n)];
    const call = await proveTransaction(snarkjs, {
      leaves: tree.leaves, inputs: [deposit, null], outputs: [change, dummyOutput(vault, rnd), dummyOutput(vault, rnd)],
      withdrawal: { vault, amount: 4n * 10n ** 17n, recipient: 0xb0bn }, outDataHash: payloads.map(noteDataHash) as [bigint, bigint, bigint], txDomain: txDomain(chainId, core),
    }, { wasm, zkey, verificationKey: vk });
    expect(call.publicInputs.root).toBe(tree.root);
    expect(call.publicInputs.nullifier0).toBe(nullifier(noteCommitment(noteBody(deposit), 0n), keys.spendKey));
    expect(call.publicInputs.withdrawalRecipient).toBe(0xb0bn);
    expect(call.publicInputs.outputBody0).toBe(noteBody(change));
    expect(call.publicInputs.noteData1Hash).toBe(noteDataHash(payloads[1]));
    expect(await snarkjs.groth16.verify(vk, call.publicSignals.map(String), call.proofJson)).toBe(true);
    // the ordering guard: a shuffled signal list is rejected
    expect(() => publicInputsFromSignals(call.publicSignals.slice(1))).toThrow(/expected 14/);
    expect(expectedPublicSignals({ ...({} as any), root: "1", nullifier: ["2", "3"], outputBody: ["4", "5", "6"], mode: "1", withdrawalVault: "7", withdrawalAmount: "8", withdrawalRecipient: "9", outDataHash: ["10", "11", "12"], txDomain: "13" })).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 1n, 7n, 8n, 9n, 10n, 11n, 12n, 13n]);
  }, 180_000);
});
