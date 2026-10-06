// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Moves the tokens but returns a non-standard 64-byte payload from transfer/transferFrom
/// instead of a bool. The vault's strict decoder must treat this as a failure rather than guess.
contract MalformedToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external {
        _move(msg.sender, to, amount);
        _weirdReturn();
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(allowance[from][msg.sender] >= amount, "allowance");
        _move(from, to, amount);
        _weirdReturn();
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }

    function _weirdReturn() internal pure {
        assembly {
            mstore(0, 1)
            mstore(32, 1)
            return(0, 64)
        }
    }
}
