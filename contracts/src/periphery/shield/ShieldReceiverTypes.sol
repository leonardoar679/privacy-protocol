// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ShieldReceiverTypes — what a same-chain swap's one-time receiver commits to (Privacy Wallet Web spec v2.0 §11.2)
library ShieldReceiverTypes {
    /// shieldTip MUST be <= minAmount / TIP_DIVISOR (1 %).
    uint256 internal constant TIP_DIVISOR = 100;

    /// Everything the receiver commits to. Its CREATE2 address is a function of these values, so the wallet computes it
    /// before the swap, names it as the swap's destination, and any relayer may deploy it and shield what arrived
    /// later — always into the committed note, never anywhere else (an unsupported token only to the fallback).
    struct ReceiverParams {
        bytes32 receiptId; // random, unique; the CREATE2 salt
        address asset; // what the swap delivers: address(0) = ETH, else the ERC-20
        uint256 minAmount; // the swap's guaranteed minimum: the tip is paid only on a delivery of at least this
        uint256 shieldTip; // paid once to whoever shields a delivery >= minAmount; <= minAmount / 100
        uint256 ownerCommitment; // the note the delivery becomes
        uint256 noteSecret;
        bytes32 noteDataHash; // keccak256 of the payload supplied at shield time
        address fallbackRecipient; // a fresh address of the wallet: the only place an unsupported token can go
    }

    error TipTooLarge();
    error ZeroFallback();
    error ZeroMinimum();
    error NoteDataMismatch();
    error NoVault();
    error VaultExists();
    error NothingToShield();
    error NotAForeignToken();
    error TokenCallFailed();
    error TipTransferFailed();
}
