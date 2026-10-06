// Emit the shared protocol vectors so the contracts, the circuit, this reference and the Python
// reference agree on every primitive (spec §17). Output: circuits/vectors/primitives.json
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { utf8ToBytes, bytesToHex } from "@noble/hashes/utils";
import { FIELD } from "./field";
import * as D from "./domains";
import { noteBody, noteCommitment, ownerCommitmentOf } from "./note";
import { nullifier, phantomNullifier } from "./nullifier";
import { MerkleTree, ZERO_LEAF, GROUP_SIZE } from "./merkle";
import { deriveKeys, deriveNoteSecret } from "./keys";
import { NOTE_DATA_BYTES, noteDataHash, testNoteData, txDomain } from "./payload";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "..", "..", "circuits", "vectors");

const keys = deriveKeys(utf8ToBytes("privacy-protocol/example-master-seed"));
const ownerCommitment = ownerCommitmentOf(keys.spendKey);
const vaultId = 0xabn; // example vault address as uint
const amount = 10n ** 18n;
const noteSecret = deriveNoteSecret(keys.noteKey, 0);

const note = { vaultId, amount, ownerCommitment, noteSecret };
const body = noteBody(note);
const commitment = noteCommitment(body, 0n);
const nf = nullifier(commitment, keys.spendKey);
const phantom = phantomNullifier(nf, 1, keys.spendKey);

// tree: a deposit group, then a transaction group of three outputs
const tree = new MerkleTree(10);
const emptyRoot = tree.root;
tree.insertLeaf(commitment);
const rootAfterDeposit = tree.root;
const outs = [2n * amount, 3n * amount, 0n].map((a, k) =>
  noteCommitment(noteBody({ vaultId, amount: a, ownerCommitment, noteSecret: deriveNoteSecret(keys.noteKey, k + 1) }), BigInt(4 + k)),
);
tree.insertGroup([outs[0], outs[1], outs[2], ZERO_LEAF]);
const rootAfterTx = tree.root;

const noteData = testNoteData(7n);
const vectors = {
  field: FIELD,
  zeroLeaf: ZERO_LEAF,
  groupSize: GROUP_SIZE,
  domains: {
    NOTE_BODY: D.NOTE_BODY,
    NOTE_COMMITMENT: D.NOTE_COMMITMENT,
    OWNER_COMMITMENT: D.OWNER_COMMITMENT,
    NULLIFIER: D.NULLIFIER,
    PHANTOM_NULLIFIER: D.PHANTOM_NULLIFIER,
    OUTPUT_BINDING_TAG: D.tagString("OUTPUT_BINDING"),
    TX_DOMAIN_TAG_KECCAK: "0x" + bytesToHex(D.TX_DOMAIN_TAG),
  },
  // nargo / barretenberg v5.2.0 known answers for the hash itself (spec §2)
  poseidon2: {
    "permute([0,0,0,0])[0]": 0x18dfb8dc9b82229cff974efefc8df78b1ce96d9d844236b496785c698bc6732en,
    "permute([1,2,3,4])[0]": 0x224785a48a72c75e2cbb698143e71d5d41bd89a2b9a7185871e39a54ce5785b1n,
    "permute([1,2,3,4])[3]": 0x16c877b5b9c04d873218804ccbf65d0eeb12db447f66c9ca26fec380055df7e9n,
    "hash([0])": 0x2710144414c3a5f2354f4c08d52ed655b9fe253b4bf12cb9ad3de693d9b1db11n,
    "hash([1])": 0x168758332d5b3e2d13be8048c8011b454590e06c44bce7f702f09103eef5a373n,
    "hash([0,0])": 0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1n,
    "hash([1,2])": 0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383n,
    "hash([0,0,0])": 0x2a5de47ed300af27b706aaa14762fc468f5cfc16cd8116eb6b09b0f2643ca2b9n,
    "hash([1,2,3])": 0x23864adb160dddf590f1d3303683ebcb914f828e2635f6e85a32f0a1aecd3dd8n,
    "hash([1,2,3,4])": 0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9n,
  },
  keys,
  sampleNote: { ownerCommitment, vaultId, amount, noteSecret, leafIndex: 0n, body, commitment, nullifier: nf, phantom },
  tree: { levels: 10, emptyRoot, rootAfterDeposit, outputs: outs, rootAfterTx },
  txDomainExample: { chainId: 31337n, core: 0xcafen, txDomain: txDomain(31337n, 0xcafen) },
  noteDataExample: { bytes: NOTE_DATA_BYTES, hex: "0x" + bytesToHex(noteData), hash: noteDataHash(noteData) },
};

const json = JSON.stringify(vectors, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "primitives.json"), json + "\n");
console.log(`wrote ${join(outDir, "primitives.json")}`);
console.log(`sample commitment = ${commitment}`);
console.log(`sample nullifier  = ${nf}`);
