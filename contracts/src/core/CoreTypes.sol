// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CoreTypes
/// @notice The frozen types of the core ABI (spec §13–§14): the public-input struct, every error,
/// and the protocol identifiers. Changing anything here after audit is a new protocol version.
library CoreTypes {
    /// Fixed 2-input / 3-output transaction public inputs. Field order is the verifier's public
    /// input order (spec §11) and is part of the circuit contract.
    struct PublicInputs {
        uint256 root;
        uint256 nullifier0;
        uint256 nullifier1;
        uint256 outputBody0;
        uint256 outputBody1;
        uint256 outputBody2;
        uint256 mode; // 0 = internal transfer, 1 = public withdrawal
        uint256 withdrawalVault; // canonical vault address as uint; 0 for a transfer
        uint256 withdrawalAmount; // 0 for a transfer
        uint256 withdrawalRecipient; // recipient address as uint; 0 for a transfer
        uint256 noteData0Hash; // binding of the fixed-size encrypted output payloads (spec §12)
        uint256 noteData1Hash;
        uint256 noteData2Hash;
        uint256 txDomain; // binds chain, core and circuit (spec §11)
    }

    uint256 internal constant N_PUBLIC_INPUTS = 14;
    uint256 internal constant MODE_TRANSFER = 0;
    uint256 internal constant MODE_WITHDRAW = 1;

    /// Fixed-size encrypted output payload (spec §12).
    uint256 internal constant NOTE_DATA_BYTES = 169;

    /// Protocol identifiers (spec §1).
    bytes32 internal constant PROTOCOL_ID = keccak256("privacy-protocol/v1.0");
    bytes32 internal constant CIRCUIT_ID =
        keccak256("privacy-protocol/v1/circuit/transaction-2in3out-depth32-poseidon2");
    bytes32 internal constant HASH_ID = keccak256("poseidon2-bn254-t4-rf8-rp56/noir-sponge/v1");
    uint256 internal constant VAULT_VERSION = 1;

    // ---- failure states (spec §15), deterministic meaning ----
    error InvalidMode();
    error InvalidTxDomain();
    error MalformedNoteData(uint8 index);
    error UnboundNoteData(uint8 index);
    error UnknownRoot();
    error DuplicateNullifier();
    error SpentNullifier(uint256 nullifier);
    error InvalidProof();
    error InvalidVault();
    error ZeroWithdrawal();
    error TransferMustCarryNoWithdrawal();
    error CallerNotCanonicalVault();
    error VerifierNotContract();
}
