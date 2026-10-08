// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A Chainlink-shaped feed for a devnet: the runtime code is placed at a mainnet proxy address with
/// hardhat_setCode; slot 0 holds the answer (8 decimals), slot 1 the description as a short bytes32.
contract MockFeed {
    int256 private answer;   // slot 0
    bytes32 private desc;    // slot 1

    function decimals() external pure returns (uint8) { return 8; }

    function description() external view returns (string memory) {
        bytes32 d = desc;
        uint256 n = 0;
        while (n < 32 && d[n] != 0) n++;
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; i++) out[i] = d[i];
        return string(out);
    }

    function latestRoundData() external view returns (uint80 roundId, int256 a, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}
