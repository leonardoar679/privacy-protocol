// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev WETH9 where it matters to the escrow: `deposit` wraps msg.value, `withdraw` unwraps with
/// `transfer` (a 2300-gas stipend to the caller, as WETH9 does), balances are plain ERC-20. `setBroken`
/// makes `withdraw` revert, to show a broken wrapped token never blocks an ETH refund.
contract WETH9Mock {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public broken;

    function setBroken(bool b) external {
        broken = b;
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 wad) external {
        require(!broken, "WETH: broken");
        require(balanceOf[msg.sender] >= wad, "WETH: balance");
        balanceOf[msg.sender] -= wad;
        payable(msg.sender).transfer(wad);
    }

    function approve(address spender, uint256 wad) external returns (bool) {
        allowance[msg.sender][spender] = wad;
        return true;
    }

    function transfer(address to, uint256 wad) external returns (bool) {
        return transferFrom(msg.sender, to, wad);
    }

    function transferFrom(address from, address to, uint256 wad) public returns (bool) {
        require(balanceOf[from] >= wad, "WETH: balance");
        if (from != msg.sender && allowance[from][msg.sender] != type(uint256).max) {
            require(allowance[from][msg.sender] >= wad, "WETH: allowance");
            allowance[from][msg.sender] -= wad;
        }
        balanceOf[from] -= wad;
        balanceOf[to] += wad;
        return true;
    }

    receive() external payable {
        deposit();
    }
}
