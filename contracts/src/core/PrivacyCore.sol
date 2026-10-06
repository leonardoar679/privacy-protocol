// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleAccumulator} from "../libraries/MerkleAccumulator.sol";
import {IHasher} from "../libraries/IHasher.sol";
import {FieldLib} from "../libraries/FieldLib.sol";
import {NoteLib} from "../libraries/NoteLib.sol";
import {DomainSeparators} from "../libraries/DomainSeparators.sol";
import {IProofVerifier} from "../verifier/IProofVerifier.sol";
import {IPrivacyCore} from "./IPrivacyCore.sol";
import {CoreTypes} from "./CoreTypes.sol";
import {IAssetVault} from "../vault/IAssetVault.sol";
import {IAssetVaultFactory} from "../factory/IAssetVaultFactory.sol";
import {AssetVaultFactory} from "../factory/AssetVaultFactory.sol";
import {ReentrancyGuard} from "../utils/ReentrancyGuard.sol";

/// @title PrivacyCore
/// @notice The immutable, asset-free cryptographic state machine (spec §13). It owns the global
/// commitment tree, the nullifier set, the block-based root history and proof verification — and
/// nothing else. It has NO owner/admin/upgrade/pause/rescue, holds NO ETH or ERC-20 (every asset
/// lives in its own canonical vault), and knows no governance, bridge or relayer.
/// "The ideal core is boring" — it owns the state machine, not the money.
contract PrivacyCore is IPrivacyCore, MerkleAccumulator, ReentrancyGuard {
    IProofVerifier private immutable _VERIFIER;
    address private immutable _VAULT_FACTORY;
    uint256 public immutable EXECUTION_CHAIN_ID;
    /// Binds every proof to this chain, this core and this circuit (spec §11).
    uint256 public immutable TX_DOMAIN;

    mapping(uint256 => bool) public spentNullifier;

    constructor(IProofVerifier verifier_, IHasher hasher_, uint256 levels_) MerkleAccumulator(levels_, hasher_) {
        if (address(verifier_).code.length == 0) revert CoreTypes.VerifierNotContract();
        _VERIFIER = verifier_;
        EXECUTION_CHAIN_ID = block.chainid;
        TX_DOMAIN = uint256(
            keccak256(
                abi.encode(
                    DomainSeparators.TX_DOMAIN_TAG,
                    CoreTypes.PROTOCOL_ID,
                    block.chainid,
                    address(this),
                    CoreTypes.CIRCUIT_ID
                )
            )
        ) % FIELD_SIZE;
        // The core deploys its own factory so both bindings are immutable and no setter is ever
        // needed (breaks the core<->factory constructor cycle without an admin).
        _VAULT_FACTORY = address(new AssetVaultFactory(address(this)));
    }

    // ---------------------------------------------------------------------------------------------
    // Deposit (public shield, spec §6) — only a canonical vault may register a note.
    // ---------------------------------------------------------------------------------------------
    function commitDeposit(uint256 ownerCommitment, uint256 noteSecret, uint256 amount, bytes calldata noteData)
        external
        override
        returns (uint32 leafIndex)
    {
        if (!IAssetVaultFactory(_VAULT_FACTORY).isCanonical(msg.sender)) revert CoreTypes.CallerNotCanonicalVault();
        FieldLib.requireField(ownerCommitment);
        FieldLib.requireField(noteSecret);
        FieldLib.requireAmount(amount);
        if (noteData.length != CoreTypes.NOTE_DATA_BYTES) revert CoreTypes.MalformedNoteData(0);

        uint256 vaultId = uint256(uint160(msg.sender)); // binds the note to its asset's vault
        uint256 body = NoteLib.noteBody(_HASHER, vaultId, amount, ownerCommitment, noteSecret);
        leafIndex = nextLeafIndex;
        uint256 commitment = NoteLib.noteCommitment(_HASHER, body, uint256(leafIndex));
        _insertGroup([commitment, ZERO_LEAF, ZERO_LEAF, ZERO_LEAF]);
        emit NoteInserted(leafIndex, commitment, noteData);
    }

    // ---------------------------------------------------------------------------------------------
    // Private transact — the preferred operation (spec §13.2). Ordering is CEI-safe.
    // ---------------------------------------------------------------------------------------------
    function transact(
        bytes calldata proof,
        CoreTypes.PublicInputs calldata pi,
        bytes calldata noteData0,
        bytes calldata noteData1,
        bytes calldata noteData2
    ) external nonReentrant {
        // 1. canonical encoding of every field entering the verifier
        FieldLib.requireField(pi.root);
        FieldLib.requireField(pi.nullifier0);
        FieldLib.requireField(pi.nullifier1);
        FieldLib.requireField(pi.outputBody0);
        FieldLib.requireField(pi.outputBody1);
        FieldLib.requireField(pi.outputBody2);
        FieldLib.requireField(pi.noteData0Hash);
        FieldLib.requireField(pi.noteData1Hash);
        FieldLib.requireField(pi.noteData2Hash);
        if (pi.mode > CoreTypes.MODE_WITHDRAW) revert CoreTypes.InvalidMode();

        // 2. chain / core / circuit binding (no replay on another chain or deployment)
        if (pi.txDomain != TX_DOMAIN) revert CoreTypes.InvalidTxDomain();

        // 3. output-data binding: the emitted ciphertexts are pinned to the proof, so a relayer
        //    cannot swap a recipient's payload after the proof is generated.
        _requireBoundNoteData(0, noteData0, pi.noteData0Hash);
        _requireBoundNoteData(1, noteData1, pi.noteData1Hash);
        _requireBoundNoteData(2, noteData2, pi.noteData2Hash);

        // 4. root must be known within the block-based window
        if (!isKnownRoot(bytes32(pi.root))) revert CoreTypes.UnknownRoot();

        // 5. nullifiers distinct and unspent
        if (pi.nullifier0 == pi.nullifier1) revert CoreTypes.DuplicateNullifier();
        if (spentNullifier[pi.nullifier0]) revert CoreTypes.SpentNullifier(pi.nullifier0);
        if (spentNullifier[pi.nullifier1]) revert CoreTypes.SpentNullifier(pi.nullifier1);

        // 6. verify the proof over the frozen public-input vector
        if (!_VERIFIER.verify(encodePublicInputs(pi), proof)) revert CoreTypes.InvalidProof();

        // 7. mode-specific public-input rules the contract itself can enforce
        bool withdraw = pi.mode == CoreTypes.MODE_WITHDRAW;
        if (withdraw) {
            FieldLib.requireAddress(pi.withdrawalVault);
            FieldLib.requireAddress(pi.withdrawalRecipient);
            FieldLib.requireAmount(pi.withdrawalAmount);
            if (pi.withdrawalAmount == 0) revert CoreTypes.ZeroWithdrawal();
            if (!IAssetVaultFactory(_VAULT_FACTORY).isCanonical(address(uint160(pi.withdrawalVault)))) {
                revert CoreTypes.InvalidVault();
            }
        } else if (pi.withdrawalVault != 0 || pi.withdrawalAmount != 0 || pi.withdrawalRecipient != 0) {
            revert CoreTypes.TransferMustCarryNoWithdrawal();
        }

        // 8. EFFECTS before INTERACTIONS (CEI): consume nullifiers, append outputs, advance root.
        spentNullifier[pi.nullifier0] = true;
        spentNullifier[pi.nullifier1] = true;
        uint32 first = nextLeafIndex;
        uint256 c0 = NoteLib.noteCommitment(_HASHER, pi.outputBody0, uint256(first));
        uint256 c1 = NoteLib.noteCommitment(_HASHER, pi.outputBody1, uint256(first) + 1);
        uint256 c2 = NoteLib.noteCommitment(_HASHER, pi.outputBody2, uint256(first) + 2);
        _insertGroup([c0, c1, c2, ZERO_LEAF]);
        emit NoteInserted(first, c0, noteData0);
        emit NoteInserted(first + 1, c1, noteData1);
        emit NoteInserted(first + 2, c2, noteData2);
        emit ShieldedTransaction(pi.nullifier0, pi.nullifier1, c0, c1, c2);

        // 9. INTERACTION: public exit through the canonical vault (non-reverting; claimable on fail).
        if (withdraw) {
            IAssetVault(address(uint160(pi.withdrawalVault))).release(
                address(uint160(pi.withdrawalRecipient)), pi.withdrawalAmount
            );
        }
    }

    function _requireBoundNoteData(uint8 k, bytes calldata noteData, uint256 expectedHash) private pure {
        if (noteData.length != CoreTypes.NOTE_DATA_BYTES) revert CoreTypes.MalformedNoteData(k);
        if (noteDataHash(noteData) != expectedHash) revert CoreTypes.UnboundNoteData(k);
    }

    /// @notice Binding of a fixed-size output payload (spec §12).
    function noteDataHash(bytes calldata noteData) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(DomainSeparators.OUTPUT_BINDING_TAG, noteData))) % FIELD_SIZE;
    }

    function isNullifierSpent(uint256 nullifier) external view returns (bool) {
        return spentNullifier[nullifier];
    }

    /// @notice Frozen public-input encoding consumed by the verifier (spec §11). Any tamper of a
    /// field changes this vector, so a proof bound to one recipient/amount/vault cannot be reused
    /// for another.
    function encodePublicInputs(CoreTypes.PublicInputs calldata pi) public pure returns (uint256[] memory out) {
        out = new uint256[](CoreTypes.N_PUBLIC_INPUTS);
        out[0] = pi.root;
        out[1] = pi.nullifier0;
        out[2] = pi.nullifier1;
        out[3] = pi.outputBody0;
        out[4] = pi.outputBody1;
        out[5] = pi.outputBody2;
        out[6] = pi.mode;
        out[7] = pi.withdrawalVault;
        out[8] = pi.withdrawalAmount;
        out[9] = pi.withdrawalRecipient;
        out[10] = pi.noteData0Hash;
        out[11] = pi.noteData1Hash;
        out[12] = pi.noteData2Hash;
        out[13] = pi.txDomain;
    }

    // ---- identifiers and immutables (spec §1, §14) ----
    function VERIFIER() external view returns (address) {
        return address(_VERIFIER);
    }

    function VAULT_FACTORY() external view returns (address) {
        return _VAULT_FACTORY;
    }

    function HASHER() external view returns (address) {
        return address(_HASHER);
    }

    function PROTOCOL_ID() external pure returns (bytes32) {
        return CoreTypes.PROTOCOL_ID;
    }

    function CIRCUIT_ID() external pure returns (bytes32) {
        return CoreTypes.CIRCUIT_ID;
    }

    function HASH_ID() external pure returns (bytes32) {
        return CoreTypes.HASH_ID;
    }

    function NOTE_DATA_BYTES() external pure returns (uint256) {
        return CoreTypes.NOTE_DATA_BYTES;
    }
}
