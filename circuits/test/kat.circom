pragma circom 2.2.2;

// Known-answer test (KAT) circuit. Part A: the hash itself against the nargo vectors (spec §2).
// Part B: every protocol primitive against vectors/primitives.json (owner commitment, body,
// commitment, nullifier, phantom nullifier, and the 4-aligned-group tree roots). Run: node test/kat.mjs
include "../lib/poseidon2/poseidon2.circom";
include "../lib/poseidon2_hash.circom";
include "../note.circom";
include "../nullifier.circom";
include "../merkle.circom";

template KAT(levels) {
    signal input spendKey;
    signal input amount;
    signal input vaultId;
    signal input noteSecret;
    signal input zeroLeaf;
    signal input outputs[3];      // the three output commitments of the vector's transaction group

    // ---- A: hash vectors ----
    signal output perm0000_0;
    signal output perm1234_0;
    signal output perm1234_3;
    signal output h0;
    signal output h1;
    signal output h00;
    signal output h12;
    signal output h000;
    signal output h123;
    signal output h1234;

    component p0 = Poseidon2(4);
    for (var i = 0; i < 4; i++) { p0.in[i] <== 0; }
    perm0000_0 <== p0.out[0];
    component p1 = Poseidon2(4);
    for (var i = 0; i < 4; i++) { p1.in[i] <== i + 1; }
    perm1234_0 <== p1.out[0];
    perm1234_3 <== p1.out[3];

    component H0 = Poseidon2Hash(1);  H0.in[0] <== 0;  h0 <== H0.out;
    component H1 = Poseidon2Hash(1);  H1.in[0] <== 1;  h1 <== H1.out;
    component H00 = Poseidon2Hash(2); H00.in[0] <== 0; H00.in[1] <== 0; h00 <== H00.out;
    component H12 = Poseidon2Hash(2); H12.in[0] <== 1; H12.in[1] <== 2; h12 <== H12.out;
    component H000 = Poseidon2Hash(3); for (var i = 0; i < 3; i++) { H000.in[i] <== 0; } h000 <== H000.out;
    component H123 = Poseidon2Hash(3); for (var i = 0; i < 3; i++) { H123.in[i] <== i + 1; } h123 <== H123.out;
    component H1234 = Poseidon2Hash(4); for (var i = 0; i < 4; i++) { H1234.in[i] <== i + 1; } h1234 <== H1234.out;

    // ---- B: protocol primitives ----
    signal output ownerCommitment;
    signal output body;
    signal output commitment;
    signal output nullifier;
    signal output phantom;
    signal output emptyRoot;
    signal output rootAfterDeposit;
    signal output rootAfterTx;

    component oc = OwnerCommitment();
    oc.ownerKey <== spendKey;
    ownerCommitment <== oc.out;

    component n0 = NoteCommitment();   // the sample note at leaf 0
    n0.vaultId <== vaultId;
    n0.amount <== amount;
    n0.ownerCommitment <== oc.out;
    n0.noteSecret <== noteSecret;
    n0.leafIndex <== 0;
    body <== n0.body;
    commitment <== n0.commitment;

    component nf = NullifierHasher();
    nf.commitment <== n0.commitment;
    nf.ownerKey <== spendKey;
    nullifier <== nf.nullifier;

    component ph = PhantomNullifier();
    ph.nullifier0 <== nf.nullifier;
    ph.inputIndex <== 1;
    ph.ownerKey0 <== spendKey;
    phantom <== ph.nullifier;

    // zero-subtree chain: z[0] = empty leaf, z[i+1] = H(z[i], z[i])
    signal zeros[levels + 1];
    component zh[levels];
    zeros[0] <== zeroLeaf;
    for (var i = 0; i < levels; i++) {
        zh[i] = HashLeftRight();
        zh[i].left <== zeros[i];
        zh[i].right <== zeros[i];
        zeros[i + 1] <== zh[i].hash;
    }
    emptyRoot <== zeros[levels];

    // root after the deposit group [c, Z, Z, Z]: the single-leaf path of leaf 0 is all zeros
    component m1 = MerkleProof(levels);
    m1.leaf <== n0.commitment;
    for (var j = 0; j < levels; j++) {
        m1.pathElements[j] <== zeros[j];
        m1.pathIndices[j] <== 0;
    }
    rootAfterDeposit <== m1.root;

    // root after the transaction group [o0, o1, o2, Z] at leaves 4..7: prove leaf 5 (o1) with its
    // real siblings: o0 at level 0, H(o2, Z) at level 1, the deposit group's node at level 2.
    component g0 = HashLeftRight(); g0.left <== outputs[2]; g0.right <== zeroLeaf;
    component d0 = HashLeftRight(); d0.left <== n0.commitment; d0.right <== zeroLeaf;
    component d1 = HashLeftRight(); d1.left <== d0.hash; d1.right <== zeros[1];
    component m2 = MerkleProof(levels);
    m2.leaf <== outputs[1];
    m2.pathElements[0] <== outputs[0]; m2.pathIndices[0] <== 1;
    m2.pathElements[1] <== g0.hash;    m2.pathIndices[1] <== 0;
    m2.pathElements[2] <== d1.hash;    m2.pathIndices[2] <== 1;
    for (var k = 3; k < levels; k++) {
        m2.pathElements[k] <== zeros[k];
        m2.pathIndices[k] <== 0;
    }
    rootAfterTx <== m2.root;
}

component main = KAT(10);
