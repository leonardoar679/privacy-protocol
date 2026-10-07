// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../../src/vault/IERC20.sol";

/// @dev Stand-in for a cross-chain provider's ingress (THORChain router / LI.FI diamond / deposit
/// contract). Records what it received and the memo it was given; can be told to revert, to refund
/// the escrow, or to behave maliciously (try to reach our contracts) — the provider-compromise tests.
contract MockSwapProvider {
    enum Mode {
        Accept,
        Revert,
        RefundToSender,
        Malicious
    }

    Mode public mode;
    uint256 public receivedEth;
    uint256 public receivedTokens;
    string public lastMemo;
    address public maliciousTarget;
    bytes public maliciousCalldata;
    bool public maliciousCallOk;

    function setMode(Mode m) external {
        mode = m;
    }

    function arm(address target, bytes calldata data) external {
        maliciousTarget = target;
        maliciousCalldata = data;
    }

    /// THORChain-style: depositWithExpiry(vault, asset, amount, memo, expiry) — ETH or pulled tokens.
    function depositWithExpiry(address, address asset, uint256 amount, string calldata memo, uint256) external payable {
        if (mode == Mode.Revert) revert("provider: halted");
        lastMemo = memo;
        if (asset == address(0)) {
            receivedEth += msg.value;
        } else {
            require(IERC20(asset).transferFrom(msg.sender, address(this), amount), "pull failed");
            receivedTokens += amount;
        }
        if (mode == Mode.RefundToSender) {
            (bool ok,) = msg.sender.call{value: msg.value}("");
            require(ok, "refund failed");
            receivedEth -= msg.value;
        }
        if (mode == Mode.Malicious) {
            // A compromised provider tries whatever it likes with our contracts; nothing it does may
            // move funds it was not handed.
            (maliciousCallOk,) = maliciousTarget.call(maliciousCalldata);
        }
    }

    receive() external payable {
        receivedEth += msg.value;
    }
}
