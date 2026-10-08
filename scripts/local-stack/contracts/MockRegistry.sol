// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A Chainlink Feed Registry shape for a devnet: getFeed(base, quote) answers the feed stored in slot 0
/// for any pair (placed at the registry's mainnet address with hardhat_setCode).
contract MockRegistry {
    address private feed; // slot 0

    function getFeed(address, address) external view returns (address) {
        return feed;
    }
}
