pragma circom 2.1.6;

// =====================================================================================
// 2-input / 3-output shielded transaction — docs/protocol-spec-v1.0.md §10 (constraints C1–C13).
// Compiled and exercised in this repo: known-answer tests (test/kat.mjs), a witness-level soundness
// harness (test/witness.mjs) and a Groth16 proof/verifier harness over a DEV setup (test/prove.mjs).
// Not externally audited; the dev setup is insecure by design (spec §18).
// Fixes vs the pre-audit draft (kept at test/regressions/transaction_v0_draft.circom):
//   PP-C01  the owner commitment is DERIVED from the spending key (C4)
//   PP-C02  a phantom input's nullifier is DERIVED (C8), never chosen
//   PP-C03  nullifiers within one transaction are distinct (C9)
//   PP-P01  notes carry a per-note secret (C5, C10)
//   PP-P02  the phantom nullifier includes the private spending key, so it is not recomputable (C8)
// =====================================================================================

include "circomlib/circuits/bitify.circom";
include "lib/poseidon2_hash.circom";
include "lib/domains.circom";
include "note.circom";
include "nullifier.circom";
include "merkle.circom";

// Fixed shape: 2 inputs, 3 outputs. Input 0 is always real; input 1 may be a phantom pad.
template Transaction(levels, nIns, nOuts) {
    // ---- public inputs (order = spec §11 = PrivacyCore.encodePublicInputs) ----
    signal input root;
    signal input nullifier[nIns];
    signal input outputBody[nOuts];
    signal input mode;                // 0 = internal transfer, 1 = public withdrawal
    signal input withdrawalVault;
    signal input withdrawalAmount;
    signal input withdrawalRecipient; // bound only (anti-tamper)
    signal input outDataHash[nOuts];  // bound payload hashes (spec §12)
    signal input txDomain;            // bound (chain / core / circuit, spec §11)

    // ---- private witness: inputs ----
    signal input inAmount[nIns];
    signal input inVaultId[nIns];
    signal input inOwnerKey[nIns];    // spending key; the owner commitment is derived from it
    signal input inNoteSecret[nIns];
    signal input inLeafIndex[nIns];
    signal input inPathElements[nIns][levels];
    signal input inPathIndices[nIns][levels];
    signal input inIsReal[nIns];      // boolean; input 0 forced real below

    // ---- private witness: outputs ----
    signal input outAmount[nOuts];
    signal input outVaultId[nOuts];
    signal input outOwnerCommitment[nOuts];
    signal input outNoteSecret[nOuts];

    // C1: keep otherwise-unused public signals constrained in the witness (anti-tamper, cf. Tornado v2.1).
    signal recipientSq; recipientSq <== withdrawalRecipient * withdrawalRecipient;
    signal domainSq;    domainSq    <== txDomain * txDomain;
    signal odSq[nOuts];
    for (var t = 0; t < nOuts; t++) { odSq[t] <== outDataHash[t] * outDataHash[t]; }

    // C2
    inIsReal[0] === 1;                // at least one real input
    mode * (1 - mode) === 0;

    // The single asset this transaction operates on (all real notes share it).
    signal asset; asset <== inVaultId[0];

    // ---- inputs: range (C3), ownership (C4), commitment (C5), membership (C6), asset (C7) ----
    component inOwner[nIns];
    component inCommit[nIns];
    component inNull[nIns];
    component inMerkle[nIns];
    component inRange[nIns];
    signal inRunning[nIns + 1];
    inRunning[0] <== 0;

    for (var i = 0; i < nIns; i++) {
        inIsReal[i] * (1 - inIsReal[i]) === 0;

        inRange[i] = Num2Bits(248);          // local range-check (improves on Nova induction, TC-15)
        inRange[i].in <== inAmount[i];

        inOwner[i] = OwnerCommitment();      // C4: only the holder of the spending key opens the note
        inOwner[i].ownerKey <== inOwnerKey[i];

        inCommit[i] = NoteCommitment();      // C5
        inCommit[i].vaultId <== inVaultId[i];
        inCommit[i].amount <== inAmount[i];
        inCommit[i].ownerCommitment <== inOwner[i].out;
        inCommit[i].noteSecret <== inNoteSecret[i];
        inCommit[i].leafIndex <== inLeafIndex[i];

        inNull[i] = NullifierHasher();
        inNull[i].commitment <== inCommit[i].commitment;
        inNull[i].ownerKey <== inOwnerKey[i];

        inMerkle[i] = MerkleProof(levels);   // C6: membership enforced only for real inputs
        inMerkle[i].leaf <== inCommit[i].commitment;
        for (var j = 0; j < levels; j++) {
            inMerkle[i].pathElements[j] <== inPathElements[i][j];
            inMerkle[i].pathIndices[j] <== inPathIndices[i][j];
        }
        (inMerkle[i].root - root) * inIsReal[i] === 0;
        (inVaultId[i] - asset) * inIsReal[i] === 0;   // C7

        inRunning[i + 1] <== inRunning[i] + inAmount[i] * inIsReal[i];
    }

    // ---- C8: nullifiers. Slot 0 is real. A phantom slot's nullifier is DERIVED from nullifier[0]
    //      and the real input's spending key — unique, unlinkable, unrecomputable. ----
    inNull[0].nullifier === nullifier[0];
    component pad[nIns - 1];
    signal realNf[nIns - 1];
    signal padNf[nIns - 1];
    for (var s = 1; s < nIns; s++) {
        pad[s - 1] = PhantomNullifier();
        pad[s - 1].nullifier0 <== nullifier[0];
        pad[s - 1].inputIndex <== s;
        pad[s - 1].ownerKey0 <== inOwnerKey[0];
        realNf[s - 1] <== inNull[s].nullifier * inIsReal[s];
        padNf[s - 1] <== pad[s - 1].nullifier * (1 - inIsReal[s]);
        nullifier[s] === realNf[s - 1] + padNf[s - 1];
    }

    // ---- C9: pairwise-distinct nullifiers (x != 0 <=> x has an inverse). ----
    signal nfDiffInv[nIns * (nIns - 1) \ 2];
    var pair = 0;
    for (var a = 0; a < nIns; a++) {
        for (var b = a + 1; b < nIns; b++) {
            nfDiffInv[pair] <-- 1 / (nullifier[a] - nullifier[b]);
            (nullifier[a] - nullifier[b]) * nfDiffInv[pair] === 1;
            pair++;
        }
    }

    // ---- outputs: range (C3), body == public outputBody (C10), same asset (C11) ----
    component outBody[nOuts];
    component outRange[nOuts];
    signal outRunning[nOuts + 1];
    outRunning[0] <== 0;

    for (var k = 0; k < nOuts; k++) {
        outRange[k] = Num2Bits(248);
        outRange[k].in <== outAmount[k];

        outBody[k] = NoteBody();
        outBody[k].vaultId <== outVaultId[k];
        outBody[k].amount <== outAmount[k];
        outBody[k].ownerCommitment <== outOwnerCommitment[k];
        outBody[k].noteSecret <== outNoteSecret[k];
        outBody[k].body === outputBody[k];       // the contract adds leafIndex to form the commitment
        outVaultId[k] === asset;                 // C11: asset conservation

        outRunning[k + 1] <== outRunning[k] + outAmount[k];
    }

    // ---- C12: mode & withdrawal binding ----
    component wRange = Num2Bits(248);
    wRange.in <== withdrawalAmount;
    (1 - mode) * withdrawalAmount === 0;             // transfer => no public exit
    mode * (withdrawalVault - asset) === 0;          // withdraw => exit the correct asset's vault

    // ---- C13: value conservation: sum(real inputs) == sum(outputs) + public withdrawal ----
    inRunning[nIns] === outRunning[nOuts] + withdrawalAmount;
}

component main {
    public [root, nullifier, outputBody, mode, withdrawalVault, withdrawalAmount, withdrawalRecipient, outDataHash, txDomain]
} = Transaction(32, 2, 3);
