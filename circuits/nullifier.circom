pragma circom 2.1.6;

include "lib/poseidon2_hash.circom";
include "lib/domains.circom";

// 1:1 nullifier (spec §5.3): binds the full note commitment + the owner's spend key, so one funded
// note yields exactly one nullifier (fixes Classic's TC-22).
template NullifierHasher() {
    signal input commitment;
    signal input ownerKey;
    signal output nullifier;

    component h = Poseidon2Hash(3);
    h.in[0] <== DOM_NULLIFIER();
    h.in[1] <== commitment;
    h.in[2] <== ownerKey;
    nullifier <== h.out;
}

// Phantom-input nullifier (spec §5.4) = H(PHANTOM_NULLIFIER, nullifier0, inputIndex, ownerKey0).
// Unique per transaction, domain-separated from real nullifiers, and NOT recomputable by an observer
// (it includes the private spending key) — so a 1-input transaction looks like a 2-input one (PP-P02).
template PhantomNullifier() {
    signal input nullifier0;
    signal input inputIndex;
    signal input ownerKey0;
    signal output nullifier;

    component h = Poseidon2Hash(4);
    h.in[0] <== DOM_PHANTOM_NULLIFIER();
    h.in[1] <== nullifier0;
    h.in[2] <== inputIndex;
    h.in[3] <== ownerKey0;
    nullifier <== h.out;
}
