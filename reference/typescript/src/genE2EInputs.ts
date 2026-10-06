// Wallet side of the end-to-end test (contracts/test/e2e/RealProofE2E.t.sol). Given the deployment
// forge dumped (vault, chain id, core's txDomain), build the witnesses for:
//   tx1  Alice shields 1 ETH, withdraws 0.6 ETH to a fresh recipient, keeps 0.35 ETH shielded and pays
//        a 0.05 ETH private relayer-fee note;
//   tx2  the relayer spends that fee note and withdraws 0.05 ETH to its own address;
// plus the fixed-size payloads and the roots the contract must reach.
// Output: circuits/test/fixtures/e2e/{tx1,tx2,meta}.json.
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { utf8ToBytes, bytesToHex } from "@noble/hashes/utils";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "./note";
import { deriveKeys, deriveNoteSecret } from "./keys";
import { MerkleTree, ZERO_LEAF } from "./merkle";
import { noteDataHash, testNoteData, txDomain } from "./payload";
import { TX_LEVELS, buildTxInputs, dummyOutput, type SpendNote } from "./txInputs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dep = JSON.parse(readFileSync(join(repo, "contracts/test/e2e/deployment.json"), "utf8"));
const vault = BigInt(dep.vault);
const chainId = BigInt(dep.chainId);
const core = BigInt(dep.core);
const domain = txDomain(chainId, core);
if (domain !== BigInt(dep.txDomain)) throw new Error(`txDomain formula mismatch: wallet ${domain} vs core ${dep.txDomain}`);

const alice = deriveKeys(utf8ToBytes("privacy-protocol/example-master-seed"));
const relayer = deriveKeys(utf8ToBytes("privacy-protocol/example-relayer"));
const aliceOC = ownerCommitmentOf(alice.spendKey);
const relayerOC = ownerCommitmentOf(relayer.spendKey);
const DEPOSIT = 10n ** 18n;
const WITHDRAWAL = 6n * 10n ** 17n;
const FEE = 5n * 10n ** 16n;
const RECIPIENT = 0xb0bn;
const RELAYER_ADDR = 0x5e1a4e5n;
let ctr = 500;
const rnd = () => deriveNoteSecret(alice.noteKey, ctr++);

// deposit: leaf 0 (group 0)
const tree = new MerkleTree(TX_LEVELS);
const depositNote: SpendNote = {
  spendKey: alice.spendKey, ownerCommitment: aliceOC, vaultId: vault, amount: DEPOSIT,
  noteSecret: deriveNoteSecret(alice.noteKey, 0), leafIndex: 0,
};
tree.insertLeaf(noteCommitment(noteBody(depositNote), 0n));
const ROOT = tree.root;

// tx1 outputs: change (leaf 4), relayer fee (leaf 5), dummy (leaf 6)
const change: Note = { vaultId: vault, amount: DEPOSIT - WITHDRAWAL - FEE, ownerCommitment: aliceOC, noteSecret: deriveNoteSecret(alice.noteKey, 1) };
const feeNote: Note = { vaultId: vault, amount: FEE, ownerCommitment: relayerOC, noteSecret: rnd() };
const tx1Payloads = [testNoteData(11n), testNoteData(12n), testNoteData(13n)];
const tx1 = buildTxInputs({
  leaves: tree.leaves,
  inputs: [depositNote, null],
  outputs: [change, feeNote, dummyOutput(vault, rnd)],
  withdrawal: { vault, amount: WITHDRAWAL, recipient: RECIPIENT },
  outDataHash: tx1Payloads.map(noteDataHash) as [bigint, bigint, bigint],
  txDomain: domain,
});
const tx1Leaves = (tx1.outputBody as string[]).map((b, k) => noteCommitment(BigInt(b), BigInt(4 + k)));
tree.insertGroup([tx1Leaves[0], tx1Leaves[1], tx1Leaves[2], ZERO_LEAF]);
const ROOT_AFTER = tree.root;

// tx2: the relayer spends its fee note (leaf 5) and exits to its own address
const feeSpend: SpendNote = { ...feeNote, spendKey: relayer.spendKey, leafIndex: 5 };
const tx2Payloads = [testNoteData(21n), testNoteData(22n), testNoteData(23n)];
const tx2 = buildTxInputs({
  leaves: tree.leaves,
  inputs: [feeSpend, null],
  outputs: [dummyOutput(vault, rnd), dummyOutput(vault, rnd), dummyOutput(vault, rnd)],
  withdrawal: { vault, amount: FEE, recipient: RELAYER_ADDR },
  outDataHash: tx2Payloads.map(noteDataHash) as [bigint, bigint, bigint],
  txDomain: domain,
});
const tx2Leaves = (tx2.outputBody as string[]).map((b, k) => noteCommitment(BigInt(b), BigInt(8 + k)));
tree.insertGroup([tx2Leaves[0], tx2Leaves[1], tx2Leaves[2], ZERO_LEAF]);
const ROOT_AFTER_2 = tree.root;

const meta = {
  vaultId: vault.toString(),
  aliceOwnerCommitment: aliceOC.toString(),
  aliceNoteSecret: depositNote.noteSecret.toString(),
  recipient: RECIPIENT.toString(),
  relayer: RELAYER_ADDR.toString(),
  deposit: DEPOSIT.toString(),
  withdrawal: WITHDRAWAL.toString(),
  fee: FEE.toString(),
  root: ROOT.toString(),
  rootAfter: ROOT_AFTER.toString(),
  rootAfter2: ROOT_AFTER_2.toString(),
  depositNoteData: "0x" + bytesToHex(testNoteData(1n)),
  noteData: [tx1Payloads, tx2Payloads].map((p) => p.map((b) => "0x" + bytesToHex(b))),
};

const outDir = join(repo, "circuits/test/fixtures/e2e");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "tx1.json"), JSON.stringify(tx1, null, 1) + "\n");
writeFileSync(join(outDir, "tx2.json"), JSON.stringify(tx2, null, 1) + "\n");
writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
console.log(`e2e witnesses for vault ${dep.vault} on chain ${chainId} -> ${outDir}`);
