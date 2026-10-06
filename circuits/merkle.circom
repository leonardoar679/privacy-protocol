pragma circom 2.1.6;

include "lib/poseidon2_hash.circom";

template HashLeftRight() {
    signal input left;
    signal input right;
    signal output hash;
    component h = Poseidon2Hash(2);
    h.in[0] <== left;
    h.in[1] <== right;
    hash <== h.out;
}

// Boolean-selected pair swap: s must be 0/1 (enforced), then orders (cur, sibling) by the path bit.
template DualMux() {
    signal input in[2];
    signal input s;
    signal output out[2];
    s * (1 - s) === 0;
    out[0] <== (in[1] - in[0]) * s + in[0];
    out[1] <== (in[0] - in[1]) * s + in[1];
}

// Recompute a Merkle root from a leaf + authentication path (the ordinary single-leaf path; the
// contract's 4-aligned leaf groups are invisible here, spec §9). The caller decides whether to force
// equality to the public root (so phantom inputs can skip it).
template MerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    component mux[levels];
    component hash[levels];
    signal cur[levels + 1];
    cur[0] <== leaf;
    for (var i = 0; i < levels; i++) {
        mux[i] = DualMux();
        mux[i].in[0] <== cur[i];
        mux[i].in[1] <== pathElements[i];
        mux[i].s <== pathIndices[i];
        hash[i] = HashLeftRight();
        hash[i].left <== mux[i].out[0];
        hash[i].right <== mux[i].out[1];
        cur[i + 1] <== hash[i].hash;
    }
    root <== cur[levels];
}
