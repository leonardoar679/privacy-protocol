pragma circom 2.1.6;

// FROZEN copy of the pre-audit nullifier.circom (circomlib Poseidon), for the v0-draft regression only.
include "circomlib/circuits/poseidon.circom";
include "domains.circom";

template NullifierHasher() {
    signal input commitment;
    signal input ownerKey;
    signal output nullifier;

    component h = Poseidon(3);
    h.inputs[0] <== DOM_NULLIFIER();
    h.inputs[1] <== commitment;
    h.inputs[2] <== ownerKey;
    nullifier <== h.out;
}
