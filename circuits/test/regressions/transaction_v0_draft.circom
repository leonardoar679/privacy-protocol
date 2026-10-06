pragma circom 2.1.6;

// =====================================================================================
// REGRESSION ARTIFACT — the pre-audit DRAFT of transaction.circom, kept verbatim (only include
// paths changed) to reproduce findings PP-C01/PP-C02. NEVER use it.
//   PP-C01: inOwnerCommitment is a FREE witness, never tied to inOwnerKey, so anyone who knows a
//           note's opening (e.g. its sender) can spend it under ANY key, and every key yields a
//           different nullifier -> one note is spendable without limit.
//   PP-C02: the phantom input's nullifier is freely chosen (default pad -> a constant nullifier).
// Fixed in ../../transaction.circom. Reproduce: node test/witness.mjs (v0-draft fixtures).
// =====================================================================================

include "circomlib/circuits/bitify.circom";
include "v0/note.circom";
include "v0/nullifier.circom";
include "v0/merkle.circom";

// Fixed shape: 2 inputs, 3 outputs. Input 0 is always real; input 1 may be a phantom pad (§29).
template Transaction(levels, nIns, nOuts) {
    // ---- public inputs (order mirrors PrivacyCore.encodePublicInputs) ----
    signal input root;
    signal input nullifier[nIns];
    signal input outputBody[nOuts];
    signal input mode;                // 0 = internal transfer, 1 = public withdrawal
    signal input withdrawalVault;
    signal input withdrawalAmount;
    signal input withdrawalRecipient; // bound only (anti-tamper)
    signal input outDataHash[nOuts];  // bound ciphertext hashes (§88)
    signal input chainId;             // bound (anti cross-chain replay)

    // ---- private witness: inputs ----
    signal input inAmount[nIns];
    signal input inVaultId[nIns];
    signal input inOwnerCommitment[nIns];
    signal input inOwnerKey[nIns];
    signal input inLeafIndex[nIns];
    signal input inPathElements[nIns][levels];
    signal input inPathIndices[nIns][levels];
    signal input inIsReal[nIns];      // boolean; input 0 forced real below

    // ---- private witness: outputs ----
    signal input outAmount[nOuts];
    signal input outVaultId[nOuts];
    signal input outOwnerCommitment[nOuts];

    // Keep otherwise-unused public signals constrained in the witness (anti-tamper, cf. Tornado v2.1).
    signal recipientSq; recipientSq <== withdrawalRecipient * withdrawalRecipient;
    signal chainSq;     chainSq     <== chainId * chainId;
    signal odSq[nOuts];
    for (var t = 0; t < nOuts; t++) { odSq[t] <== outDataHash[t] * outDataHash[t]; }

    inIsReal[0] === 1;                // at least one real input (§28)
    mode * (1 - mode) === 0;

    // The single asset this transaction operates on (all real notes share it, §32).
    signal asset; asset <== inVaultId[0];

    // ---- inputs: range, commitment, nullifier, membership, asset, value ----
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

        inCommit[i] = NoteCommitment();
        inCommit[i].ownerCommitment <== inOwnerCommitment[i];
        inCommit[i].amount <== inAmount[i];
        inCommit[i].vaultId <== inVaultId[i];
        inCommit[i].leafIndex <== inLeafIndex[i];

        inNull[i] = NullifierHasher();
        inNull[i].commitment <== inCommit[i].commitment;
        inNull[i].ownerKey <== inOwnerKey[i];
        inNull[i].nullifier === nullifier[i];

        inMerkle[i] = MerkleProof(levels);
        inMerkle[i].leaf <== inCommit[i].commitment;
        for (var j = 0; j < levels; j++) {
            inMerkle[i].pathElements[j] <== inPathElements[i][j];
            inMerkle[i].pathIndices[j] <== inPathIndices[i][j];
        }
        // membership enforced only for real inputs; asset equality likewise.
        (inMerkle[i].root - root) * inIsReal[i] === 0;
        (inVaultId[i] - asset) * inIsReal[i] === 0;

        inRunning[i + 1] <== inRunning[i] + inAmount[i] * inIsReal[i];
    }

    // ---- outputs: range, body == public outputBody, same asset ----
    component outBody[nOuts];
    component outRange[nOuts];
    signal outRunning[nOuts + 1];
    outRunning[0] <== 0;

    for (var k = 0; k < nOuts; k++) {
        outRange[k] = Num2Bits(248);
        outRange[k].in <== outAmount[k];

        outBody[k] = NoteBody();
        outBody[k].ownerCommitment <== outOwnerCommitment[k];
        outBody[k].amount <== outAmount[k];
        outBody[k].vaultId <== outVaultId[k];
        outBody[k].body === outputBody[k];       // contract adds leafIndex to form the final commitment
        outVaultId[k] === asset;                 // asset conservation (§32)

        outRunning[k + 1] <== outRunning[k] + outAmount[k];
    }

    // ---- mode & withdrawal binding ----
    component wRange = Num2Bits(248);
    wRange.in <== withdrawalAmount;
    (1 - mode) * withdrawalAmount === 0;             // transfer => no public exit
    mode * (withdrawalVault - asset) === 0;          // withdraw => exit the correct asset's vault

    // ---- value conservation (§31): sum(real inputs) == sum(outputs) + public withdrawal ----
    inRunning[nIns] === outRunning[nOuts] + withdrawalAmount;
}

component main {
    public [root, nullifier, outputBody, mode, withdrawalVault, withdrawalAmount, withdrawalRecipient, outDataHash, chainId]
} = Transaction(32, 2, 3);
