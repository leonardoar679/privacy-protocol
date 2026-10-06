// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title VaultTypes — frozen vault errors (spec §14–15)
library VaultTypes {
    error CallerNotCore();
    error ZeroAmount();
    error ZeroCore();
    error ZeroToken();
    error Undercollateralized();
    error NothingToClaim();
    error ClaimTransferFailed();
    error TokenTransferFailed();
    error UnsupportedTokenBehavior();
}
