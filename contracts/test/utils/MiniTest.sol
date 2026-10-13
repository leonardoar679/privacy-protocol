// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal vendored test harness so the suite needs no `forge install` (network-free). Only
/// the cheats/assertions this project uses. Behaviour matches forge-std's equivalents.
interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function deal(address, uint256) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function roll(uint256) external;
    function warp(uint256) external;
    function label(address, string calldata) external;
    function assume(bool) external;
    function addr(uint256) external pure returns (address);
    function envOr(string calldata name, bool defaultValue) external view returns (bool);
    function writeFile(string calldata path, string calldata data) external;
    function readFile(string calldata path) external view returns (string memory);
    function toString(address) external pure returns (string memory);
    function toString(uint256) external pure returns (string memory);
    function toString(bytes32) external pure returns (string memory);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function load(address target, bytes32 slot) external view returns (bytes32);
}

abstract contract Test {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address[] private _targets;

    function _targetContract(address a) internal {
        _targets.push(a);
    }

    // forge reads this to scope invariant fuzzing.
    function targetContracts() public view returns (address[] memory) {
        return _targets;
    }

    function assertTrue(bool c) internal pure {
        require(c, "assertTrue failed");
    }

    function assertTrue(bool c, string memory m) internal pure {
        require(c, m);
    }

    function assertFalse(bool c) internal pure {
        require(!c, "assertFalse failed");
    }

    function assertFalse(bool c, string memory m) internal pure {
        require(!c, m);
    }

    function assertEq(uint256 a, uint256 b) internal pure {
        require(a == b, "assertEq(uint) failed");
    }

    function assertEq(uint256 a, uint256 b, string memory m) internal pure {
        require(a == b, m);
    }

    function assertEq(address a, address b) internal pure {
        require(a == b, "assertEq(address) failed");
    }

    function assertEq(address a, address b, string memory m) internal pure {
        require(a == b, m);
    }

    function assertEq(bytes32 a, bytes32 b) internal pure {
        require(a == b, "assertEq(bytes32) failed");
    }

    function assertEq(bytes32 a, bytes32 b, string memory m) internal pure {
        require(a == b, m);
    }

    function assertEq(string memory a, string memory b, string memory m) internal pure {
        require(keccak256(bytes(a)) == keccak256(bytes(b)), m);
    }

    /// forge's console precompile (what forge-std's console.log talks to); shown with -vv.
    function log(string memory s, uint256 v) internal view {
        (bool ok,) = address(0x000000000000000000636F6e736F6c652e6c6f67).staticcall(
            abi.encodeWithSignature("log(string,uint256)", s, v)
        );
        ok;
    }
}
