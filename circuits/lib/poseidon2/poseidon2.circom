pragma circom 2.2.2;

include "poseidon2_constants.circom";

template Acc(t) {
    signal input in[t];
    signal output out;
    signal sums[t];
    sums[0] <== in[0];
    for (var i = 1;i<t;i++) {
        sums[i] <== sums[i-1] + in[i];
    }
    out <== sums[t-1];
}

template ExternalMatMul2 {
    signal input in[2];
    signal output out[2];
    signal sum <== in[0] + in[1];
    out[0] <== in[0] + sum;
    out[1] <== in[1] + sum;
}

template ExternalMatMul3 {
    signal input in[3];
    signal output out[3];
    signal sum <== in[0] + in[1] + in[2];
    out[0] <== in[0] + sum;
    out[1] <== in[1] + sum;
    out[2] <== in[2] + sum;
}

template ExternalMatMul4 {
    signal input in[4];
    signal output out[4];

    signal doubleIn1 <== 2 * in[1];
    signal doubleIn3 <== 2 * in[3];

    signal t0 <== in[0] + in[1];
    signal t1 <== in[2] + in[3];

    signal quadT0 <== 4 * t0;
    signal quadT1 <== 4 * t1;

    signal t2 <== doubleIn1 + t1;
    signal t3 <== doubleIn3 + t0;
    signal t4 <== quadT1 + t3;
    signal t5 <== quadT0 + t2;

    out[0] <== t3 + t5;
    out[1] <== t5;
    out[2] <== t2 + t4;
    out[3] <== t4;
}

template ExternalMatMulT(t) {
    signal input in[t];
    signal output out[t];

    if (t == 2) {
        out <== ExternalMatMul2()(in);
    } else if (t == 3) {
        out <== ExternalMatMul3()(in);
    } else if (t== 4) {
        out <== ExternalMatMul4()(in);
    } else {
        var amountMds = t / 4;
        component mds[amountMds];

        for (var i = 0;i<amountMds;i++) {
            var offset = 4 * i;
            mds[i] = ExternalMatMul4();
            for (var j = 0;j<4;j++) {
                mds[i].in[j] <== in[offset + j];
            }
        }

        component accs[4];
        for (var l = 0;l<4;l++) {
            accs[l] = Acc(amountMds);
            accs[l].in[0] <== mds[0].out[l];
            for (var j = 1;j<amountMds;j++) {
                accs[l].in[j] <== mds[j].out[l];
            }
        }

        for (var i = 0;i<amountMds;i++) {
            for (var j = 0;j<4;j++) {
                out[i * 4 + j] <== mds[i].out[j] + accs[j].out;
            }
        }
    }
}

template InternalMatMul2() {
    signal input in[2];
    signal output out[2];

    signal sum <== in[0] + in[1];
    out[0] <== in[0] + sum;
    out[1] <== 2 * in[1] + sum;
}

template InternalMatMul3() {
    signal input in[3];
    signal output out[3];

    signal sum <== in[0] + in[1] + in[2];
    out[0] <== in[0] + sum;
    out[1] <== in[1] + sum;
    out[2] <== 2 * in[2] + sum;
}

template InternalMatMulT(t) {
    signal input in[t];
    signal output out[t];

    if (t == 2) {
        out <== InternalMatMul2()(in);
    } else if (t == 3) {
        out <== InternalMatMul3()(in);
    } else {
        // Load the diagonal for the inner matrix multiplication.
        // It is the same for every round, so we could theoretically
        // load it once and pass it as a template parameter.
        // However, for widths t = 2 and t = 3 there is no diagonal,
        // so we opted to call this function each round. This may add some
        // overhead with our standard witness extension, but the graph
        // compiler hopefully eliminates this call completely.
        var diag[t] = loadDiag(t);
        signal acc <== Acc(t)(in);
        for (var i = 0;i<t;i++) {
            out[i] <== in[i] * diag[i] + acc;
        }
    }
}

template SboxE() {
    signal input in;
    signal output out;
    signal square <== in * in;
    signal pow4 <== square * square;
    out <== pow4 * in;
}

template Sbox(t) {
    signal input in[t];
    signal output out[t];

    for (var i = 0;i<t;i++) {
        out[i] <== SboxE()(in[i]);
    }
}

template FullRound(t) {
    signal input in[t];
    signal input rc[t];
    signal output out[t];

    // add full round constants
    signal linearLayer[t];
    for (var i=0;i<t;i++) {
        linearLayer[i] <== in[i] + rc[i];
    }
    // apply sbox for all elements
    signal sbox[t] <== Sbox(t)(linearLayer);

    // apply external mds matrix
    out <== ExternalMatMulT(t)(sbox);
}

template PartialRound(t) {
    signal input in[t];
    signal input rc;
    signal output out[t];

    // add rc to first element
    signal linearLayer <== in[0] + rc;

    // apply sbox to first element
    signal sbox <== SboxE()(linearLayer);

    // apply internal mds matrix
    component internalMm = InternalMatMulT(t);
    internalMm.in[0] <== sbox;
    for (var i = 1;i<t;i++) {
        internalMm.in[i] <== in[i];
    }
    out <== internalMm.out;
}

template Poseidon2(t) {
    // sanity check that we only have valid state sizes
    assert(t == 2 || t == 3 || t == 4 || t == 8 || t == 12 || t == 16);

    signal input in[t];
    signal output out[t];

    // load amount partial rounds
    var partialRounds = amountPartialRounds(t);

    // load round constants
    var rcFull1[4][t] = loadRcFull1(t);
    var rcPartial[partialRounds] = loadRcPartial(t);
    var rcFull2[4][t] = loadRcFull2(t);

    signal state[9+partialRounds][t];

    // Outer matrix mul
    state[0] <== ExternalMatMulT(t)(in);

    // First 4 full rounds
    for (var i = 0;i<4;i++) {
        state[i+1] <== FullRound(t)(state[i], rcFull1[i]);
    }

    // Partial Rounds
    for (var i = 0;i<partialRounds;i++) {
        state[i+5] <== PartialRound(t)(state[i+4], rcPartial[i]);
    }

    // Second 4 full rounds
    for (var i = 0;i<4;i++) {
        state[i+5+partialRounds] <== FullRound(t)(state[i+4+partialRounds], rcFull2[i]);
    }

    out <== state[8+partialRounds];
}
