// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CoreTypes} from "./CoreTypes.sol";

/// @title IPrivacyCore — the frozen core ABI (spec §14)
interface IPrivacyCore {
    event NoteInserted(uint32 indexed leafIndex, uint256 commitment, bytes noteData);
    event ShieldedTransaction(
        uint256 nullifier0, uint256 nullifier1, uint256 commitment0, uint256 commitment1, uint256 commitment2
    );

    /// @notice Register a processed deposit as a note leaf. Caller MUST be a canonical vault.
    function commitDeposit(uint256 ownerCommitment, uint256 noteSecret, uint256 amount, bytes calldata noteData)
        external
        returns (uint32 leafIndex);

    /// @notice The private operation: spend up to 2 notes, create 3, optionally exit through a vault.
    function transact(
        bytes calldata proof,
        CoreTypes.PublicInputs calldata pi,
        bytes calldata noteData0,
        bytes calldata noteData1,
        bytes calldata noteData2
    ) external;

    function encodePublicInputs(CoreTypes.PublicInputs calldata pi) external pure returns (uint256[] memory);
    function noteDataHash(bytes calldata noteData) external pure returns (uint256);
    function isNullifierSpent(uint256 nullifier) external view returns (bool);
    // Also on the contract, from MerkleAccumulator: isKnownRoot(bytes32), currentRoot(), nextLeafIndex(),
    // LEVELS(), ZERO_LEAF(), GROUP_SIZE(), ROOT_HISTORY_BLOCKS(), rootKnown(bytes32), rootBlock(bytes32), zeros(uint256).

    function VERIFIER() external view returns (address);
    function VAULT_FACTORY() external view returns (address);
    function HASHER() external view returns (address);
    function TX_DOMAIN() external view returns (uint256);
    function EXECUTION_CHAIN_ID() external view returns (uint256);
    function PROTOCOL_ID() external view returns (bytes32);
    function CIRCUIT_ID() external view returns (bytes32);
    function HASH_ID() external view returns (bytes32);
    function NOTE_DATA_BYTES() external view returns (uint256);
}
