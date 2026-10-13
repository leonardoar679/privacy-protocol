// Wallet side of the end-to-end test (contracts/test/e2e/RealProofE2E.t.sol). Given the deployment
// forge dumped (vault, chain id, core's txDomain), build the witnesses for:
//   tx1  Alice shields 1 ETH, withdraws 0.6 ETH to a fresh recipient, keeps 0.35 ETH shielded and pays
//        a 0.05 ETH private relayer-fee note;
//   tx2  the relayer spends that fee note and withdraws 0.05 ETH to its own address;
//   tx3  (V1.1 private swap) Alice spends her 0.35 ETH change note and withdraws it to the predicted
//        SwapOrderEscrow of a pre-committed order (CREATE2 over abi.encode(OrderParams), the same formula
//        as packages/swap-engine/src/endpoints.ts and SwapOrderFactory.predict);
//   refund  the order's failure branch re-shields (0.35 − tip) ETH as the pre-committed refund note (leaf 12);
//   tx4  Alice spends that refund note and withdraws it to a second fresh address;
// plus the fixed-size payloads and the roots the contract must reach.
// Output: circuits/test/fixtures/e2e/{tx1,tx2,tx3,tx4,meta}.json.
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { utf8ToBytes, bytesToHex } from "@noble/hashes/utils";
import { keccak_256 } from "@noble/hashes/sha3";
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
const RECIPIENT2 = 0xc0ffeen;

// ---- the pre-committed swap order (constants mirrored in RealProofE2E.t.sol::_swapParams) ----
const ORDER_ID = BigInt("0x" + bytesToHex(keccak_256(utf8ToBytes("privacy-protocol/e2e/order-1"))));
const SWAP_AMOUNT = DEPOSIT - WITHDRAWAL - FEE; // Alice's whole change note: 0.35 ETH
const SWAP_TIP = SWAP_AMOUNT / 100n; // 1 % executor tip
const EXECUTE_DEADLINE = 2_000_000_000n;
const REFUND_AFTER = 2_000_100_000n;
const REFUND_NOTE_SECRET = deriveNoteSecret(deriveKeys(utf8ToBytes("privacy-protocol/example-master-seed")).noteKey, 2);
const refundPayload = testNoteData(31n);

/** abi.encode(SwapOrderTypes.OrderParams) — 12 static words, same order as the struct. */
function encodeOrderParams(p: { orderId: bigint; assetType: bigint; asset: bigint; amount: bigint; orderSigner: bigint; executeDeadline: bigint; refundAfter: bigint; refundVault: bigint; refundOwnerCommitment: bigint; refundNoteSecret: bigint; refundNoteDataHash: bigint; executorTip: bigint }): Uint8Array {
  const words = [p.orderId, p.assetType, p.asset, p.amount, p.orderSigner, p.executeDeadline, p.refundAfter, p.refundVault, p.refundOwnerCommitment, p.refundNoteSecret, p.refundNoteDataHash, p.executorTip];
  const out = new Uint8Array(32 * words.length);
  words.forEach((w, i) => { let x = w; for (let k = 31; k >= 0; k--) { out[i * 32 + k] = Number(x & 0xffn); x >>= 8n; } });
  return out;
}
const concat = (...xs: Uint8Array[]) => { const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length; } return out; };
const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const be = (v: bigint, n: number) => { const b = new Uint8Array(n); let x = v; for (let k = n - 1; k >= 0; k--) { b[k] = Number(x & 0xffn); x >>= 8n; } return b; };

/** CREATE2(factory, salt = orderId, keccak(creationCode ‖ abi.encode(params))) — == SwapOrderFactory.predict. */
function predictEscrow(factory: bigint, creationCode: Uint8Array, params: Parameters<typeof encodeOrderParams>[0]): bigint {
  const initCodeHash = keccak_256(concat(creationCode, encodeOrderParams(params)));
  const digest = keccak_256(concat(Uint8Array.of(0xff), be(factory, 20), be(params.orderId, 32), initCodeHash));
  return BigInt("0x" + bytesToHex(digest.slice(12)));
}
const escrowArtifact = JSON.parse(readFileSync(join(repo, "contracts/out/SwapOrderEscrow.sol/SwapOrderEscrow.json"), "utf8"));
const swapParams = {
  orderId: ORDER_ID, assetType: 0n, asset: 0n, amount: SWAP_AMOUNT, orderSigner: BigInt(dep.orderSigner), executeDeadline: EXECUTE_DEADLINE, refundAfter: REFUND_AFTER,
  refundVault: vault, refundOwnerCommitment: aliceOC, refundNoteSecret: REFUND_NOTE_SECRET,
  refundNoteDataHash: BigInt("0x" + bytesToHex(keccak_256(refundPayload))), executorTip: SWAP_TIP,
};
const ESCROW = predictEscrow(BigInt(dep.swapFactory), hexBytes(escrowArtifact.bytecode.object), swapParams);
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
const treeAfterTx2 = tree.snapshot();
tree.insertGroup([tx2Leaves[0], tx2Leaves[1], tx2Leaves[2], ZERO_LEAF]);
const ROOT_AFTER_2 = tree.root;

// ---- tx3 (built on the state after tx1 only: the swap-exit tests do not run tx2) ----
tree.restore(treeAfterTx2);
const changeSpend: SpendNote = { ...change, spendKey: alice.spendKey, leafIndex: 4 };
const tx3Payloads = [testNoteData(41n), testNoteData(42n), testNoteData(43n)];
const tx3 = buildTxInputs({
  leaves: tree.leaves,
  inputs: [changeSpend, null],
  outputs: [dummyOutput(vault, rnd), dummyOutput(vault, rnd), dummyOutput(vault, rnd)],
  withdrawal: { vault, amount: SWAP_AMOUNT, recipient: ESCROW },
  outDataHash: tx3Payloads.map(noteDataHash) as [bigint, bigint, bigint],
  txDomain: domain,
});
const tx3Leaves = (tx3.outputBody as string[]).map((b, k) => noteCommitment(BigInt(b), BigInt(8 + k)));
tree.insertGroup([tx3Leaves[0], tx3Leaves[1], tx3Leaves[2], ZERO_LEAF]);
const ROOT_AFTER_3 = tree.root;

// refund branch: SwapOrderEscrow.refund re-shields (amount − tip) via vault.deposit → leaf 12
const refundNote: Note = { vaultId: vault, amount: SWAP_AMOUNT - SWAP_TIP, ownerCommitment: aliceOC, noteSecret: REFUND_NOTE_SECRET };
const refundLeaf = tree.insertLeaf(noteCommitment(noteBody(refundNote), 12n));
if (refundLeaf !== 12) throw new Error(`refund note expected at leaf 12, got ${refundLeaf}`);
const ROOT_AFTER_REFUND = tree.root;

// tx4: Alice spends the refund note and exits to a second fresh address
const refundSpend: SpendNote = { ...refundNote, spendKey: alice.spendKey, leafIndex: 12 };
const tx4Payloads = [testNoteData(51n), testNoteData(52n), testNoteData(53n)];
const tx4 = buildTxInputs({
  leaves: tree.leaves,
  inputs: [refundSpend, null],
  outputs: [dummyOutput(vault, rnd), dummyOutput(vault, rnd), dummyOutput(vault, rnd)],
  withdrawal: { vault, amount: SWAP_AMOUNT - SWAP_TIP, recipient: RECIPIENT2 },
  outDataHash: tx4Payloads.map(noteDataHash) as [bigint, bigint, bigint],
  txDomain: domain,
});
const tx4Leaves = (tx4.outputBody as string[]).map((b, k) => noteCommitment(BigInt(b), BigInt(16 + k)));
tree.insertGroup([tx4Leaves[0], tx4Leaves[1], tx4Leaves[2], ZERO_LEAF]);
const ROOT_AFTER_4 = tree.root;

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
  noteData: [tx1Payloads, tx2Payloads, tx3Payloads, tx4Payloads].map((p) => p.map((b) => "0x" + bytesToHex(b))),
  // V1.1 swap exit
  recipient2: RECIPIENT2.toString(),
  orderId: ORDER_ID.toString(),
  orderSigner: BigInt(dep.orderSigner).toString(),
  escrow: ESCROW.toString(),
  swapAmount: SWAP_AMOUNT.toString(),
  swapTip: SWAP_TIP.toString(),
  executeDeadline: EXECUTE_DEADLINE.toString(),
  refundAfter: REFUND_AFTER.toString(),
  refundNoteSecret: REFUND_NOTE_SECRET.toString(),
  refundNoteData: "0x" + bytesToHex(refundPayload),
  rootAfter3: ROOT_AFTER_3.toString(),
  rootAfterRefund: ROOT_AFTER_REFUND.toString(),
  rootAfter4: ROOT_AFTER_4.toString(),
};

const outDir = join(repo, "circuits/test/fixtures/e2e");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "tx1.json"), JSON.stringify(tx1, null, 1) + "\n");
writeFileSync(join(outDir, "tx2.json"), JSON.stringify(tx2, null, 1) + "\n");
writeFileSync(join(outDir, "tx3.json"), JSON.stringify(tx3, null, 1) + "\n");
writeFileSync(join(outDir, "tx4.json"), JSON.stringify(tx4, null, 1) + "\n");
writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
console.log(`e2e witnesses for vault ${dep.vault} on chain ${chainId} -> ${outDir}; swap escrow 0x${ESCROW.toString(16).padStart(40, "0")}`);
