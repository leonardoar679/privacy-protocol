pragma circom 2.1.6;

include "lib/poseidon2_hash.circom";
include "lib/domains.circom";

// Owner commitment = H(OWNER_COMMITMENT, spendKey) (spec §4). A spend MUST derive this from the
// spending key rather than take it as a free witness — otherwise anyone who knows a note's opening
// could spend it under any key (finding PP-C01).
template OwnerCommitment() {
    signal input ownerKey;
    signal output out;

    component h = Poseidon2Hash(2);
    h.in[0] <== DOM_OWNER_COMMITMENT();
    h.in[1] <== ownerKey;
    out <== h.out;
}

// Note body = H(NOTE_BODY, vaultId, amount, ownerCommitment, noteSecret) (spec §5.2). The per-note
// secret stops a known owner commitment from being dictionary-attacked against amounts and makes
// every dummy output unique (finding PP-P01). Leaf index is added later (NoteCommitment).
template NoteBody() {
    signal input vaultId;
    signal input amount;
    signal input ownerCommitment;
    signal input noteSecret;
    signal output body;

    component h = Poseidon2Hash(5);
    h.in[0] <== DOM_NOTE_BODY();
    h.in[1] <== vaultId;
    h.in[2] <== amount;
    h.in[3] <== ownerCommitment;
    h.in[4] <== noteSecret;
    body <== h.out;
}

// Final commitment = H(NOTE_COMMITMENT, body, leafIndex). On the DEPOSIT path and for spent INPUTS
// the leaf index is known; for fresh OUTPUTS the contract assigns the leaf index and computes this
// hash itself, so output circuits expose only `body` (see transaction.circom).
template NoteCommitment() {
    signal input vaultId;
    signal input amount;
    signal input ownerCommitment;
    signal input noteSecret;
    signal input leafIndex;
    signal output body;
    signal output commitment;

    component nb = NoteBody();
    nb.vaultId <== vaultId;
    nb.amount <== amount;
    nb.ownerCommitment <== ownerCommitment;
    nb.noteSecret <== noteSecret;
    body <== nb.body;

    component h = Poseidon2Hash(3);
    h.in[0] <== DOM_NOTE_COMMITMENT();
    h.in[1] <== body;
    h.in[2] <== leafIndex;
    commitment <== h.out;
}
