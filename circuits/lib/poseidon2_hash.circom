pragma circom 2.2.2;

include "poseidon2/poseidon2.circom";

// The protocol hash (spec §2): Poseidon2 / BN254 / t = 4 with the Noir/barretenberg sponge, over the
// vendored TaceoLabs permutation (lib/poseidon2, verbatim).
//   state = [0, 0, 0, IV], IV = n * 2^64 ; rate 3
//   absorb chunks of 3 (permute when a 4th element arrives); squeeze: add the remaining cache, permute,
//   out = state[0]. So n in 1..3 costs one permutation, n in 4..6 two.
// Known answers (nargo): test/poseidon2_kat.circom + test/kat.mjs — identical to the Solidity, TS and
// Python implementations.
template Poseidon2Hash(n) {
    assert(n >= 1 && n <= 6);
    signal input in[n];
    signal output out;

    var full = n \ 3;
    var rem = n % 3;
    var perms = full;
    if (rem != 0) { perms = full + 1; }

    component P[perms];
    signal state[perms + 1][4];
    state[0][0] <== 0;
    state[0][1] <== 0;
    state[0][2] <== 0;
    state[0][3] <== n * 18446744073709551616; // IV = n * 2^64 in the capacity element

    for (var c = 0; c < full; c++) {
        P[c] = Poseidon2(4);
        for (var j = 0; j < 3; j++) { P[c].in[j] <== state[c][j] + in[c * 3 + j]; }
        P[c].in[3] <== state[c][3];
        for (var j = 0; j < 4; j++) { state[c + 1][j] <== P[c].out[j]; }
    }
    if (rem != 0) {
        P[full] = Poseidon2(4);
        for (var j = 0; j < 3; j++) {
            if (j < rem) { P[full].in[j] <== state[full][j] + in[full * 3 + j]; }
            else         { P[full].in[j] <== state[full][j]; }
        }
        P[full].in[3] <== state[full][3];
        for (var j = 0; j < 4; j++) { state[full + 1][j] <== P[full].out[j]; }
    }
    out <== state[perms][0];
}
