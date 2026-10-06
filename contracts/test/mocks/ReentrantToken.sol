// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20Mock} from "./ERC20Mock.sol";

/// @dev Attempts to re-enter a target during transferFrom. The vault's nonReentrant guard must make
/// the re-entry fail, which (because deposit uses a STRICT transfer) reverts the whole deposit —
/// i.e. no state is corrupted (spec §63).
contract ReentrantToken is ERC20Mock {
    address public target;
    bytes public data;
    bool public armed;

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
        armed = true;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        if (armed) {
            armed = false; // one-shot
            (bool ok,) = target.call(data);
            require(ok, "reentry blocked"); // propagates so the outer call reverts
        }
        super._transfer(from, to, amount);
    }
}
