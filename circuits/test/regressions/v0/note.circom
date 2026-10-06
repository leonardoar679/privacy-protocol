pragma circom 2.1.6;

// FROZEN copy of the pre-audit note.circom (circomlib Poseidon, 4-input body, no note secret),
// kept only so test/regressions/transaction_v0_draft.circom still compiles and reproduces PP-C01.
include "circomlib/circuits/poseidon.circom";
include "domains.circom";

template NoteBody() {
    signal input ownerCommitment;
    signal input amount;
    signal input vaultId;
    signal output body;

    component h = Poseidon(4);
    h.inputs[0] <== DOM_NOTE_BODY();
    h.inputs[1] <== ownerCommitment;
    h.inputs[2] <== amount;
    h.inputs[3] <== vaultId;
    body <== h.out;
}

template NoteCommitment() {
    signal input ownerCommitment;
    signal input amount;
    signal input vaultId;
    signal input leafIndex;
    signal output body;
    signal output commitment;

    component nb = NoteBody();
    nb.ownerCommitment <== ownerCommitment;
    nb.amount <== amount;
    nb.vaultId <== vaultId;
    body <== nb.body;

    component h = Poseidon(3);
    h.inputs[0] <== DOM_NOTE_COMMITMENT();
    h.inputs[1] <== body;
    h.inputs[2] <== leafIndex;
    commitment <== h.out;
}
