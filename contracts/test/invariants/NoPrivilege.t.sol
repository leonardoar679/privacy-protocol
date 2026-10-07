// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PPTestBase} from "../PPTestBase.sol";
import {ERC20AssetVault} from "../../src/vault/ERC20AssetVault.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {SwapOrderFactory} from "../../src/periphery/swap/SwapOrderFactory.sol";
import {SwapOrderTypes} from "../../src/periphery/swap/SwapOrderTypes.sol";

/// Invariant 10 (spec §16, plan §74): no privileged state transition exists. Walks the deployed
/// RUNTIME bytecode of every production contract (skipping PUSH immediates, so data bytes are not
/// mistaken for opcodes) and asserts that no DELEGATECALL / CALLCODE / SELFDESTRUCT is present, and
/// that the core and the vaults contain no CREATE/CREATE2 either (only the factory may deploy). It
/// also asserts that no admin-style selector is dispatched. This permanently removes TC-02
/// (governance capture) from the model: there is no upgrade or arbitrary-execution path to capture.
contract NoPrivilegeTest is PPTestBase {
    ERC20AssetVault internal ercVault;

    function setUp() public {
        _deployCore();
        ercVault = ERC20AssetVault(factory.getOrCreateERC20Vault(address(new ERC20Mock())));
    }

    // ---- opcode walker -------------------------------------------------------------------------
    struct Scan {
        bool delegatecall;
        bool callcode;
        bool selfdestruct;
        bool create;
        bool create2;
        uint256 push4Count;
    }

    function _scan(address a, bytes4[] memory forbiddenSelectors) internal view returns (Scan memory s) {
        bytes memory code = a.code;
        require(code.length > 0, "no code");
        uint256 i;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            if (op >= 0x60 && op <= 0x7f) {
                uint256 n = op - 0x5f; // PUSH1..PUSH32 immediate length
                if (n == 4 && i + 4 < code.length) {
                    bytes4 sel = bytes4(bytes.concat(code[i + 1], code[i + 2], code[i + 3], code[i + 4]));
                    s.push4Count++;
                    for (uint256 k; k < forbiddenSelectors.length; ++k) {
                        require(sel != forbiddenSelectors[k], "admin-style selector dispatched");
                    }
                }
                i += 1 + n;
                continue;
            }
            if (op == 0xf4) s.delegatecall = true;
            if (op == 0xf2) s.callcode = true;
            if (op == 0xff) s.selfdestruct = true;
            if (op == 0xf0) s.create = true;
            if (op == 0xf5) s.create2 = true;
            i++;
        }
    }

    function _adminSelectors() internal pure returns (bytes4[] memory sels) {
        string[16] memory sigs = [
            "owner()", "transferOwnership(address)", "renounceOwnership()", "upgradeTo(address)",
            "upgradeToAndCall(address,bytes)", "initialize()", "pause()", "unpause()",
            "rescueETH()", "rescueToken(address)", "rescueToken(address,uint256)", "adminWithdraw(address,uint256)",
            "emergencyDrain()", "setVerifier(address)", "setVault(address,address)", "setCore(address)"
        ];
        sels = new bytes4[](sigs.length);
        for (uint256 i; i < sigs.length; ++i) {
            sels[i] = bytes4(keccak256(bytes(sigs[i])));
        }
    }

    function _assertStateMachineOnly(address a, string memory name) internal view {
        Scan memory s = _scan(a, _adminSelectors());
        assertFalse(s.delegatecall, string.concat(name, ": DELEGATECALL present"));
        assertFalse(s.callcode, string.concat(name, ": CALLCODE present"));
        assertFalse(s.selfdestruct, string.concat(name, ": SELFDESTRUCT present"));
        assertFalse(s.create, string.concat(name, ": CREATE present"));
        assertFalse(s.create2, string.concat(name, ": CREATE2 present"));
        assertTrue(s.push4Count > 0, "walker saw the dispatcher");
    }

    function test_CoreHasNoPrivilegedPath() public view {
        _assertStateMachineOnly(address(core), "PrivacyCore");
    }

    function test_VaultsHaveNoPrivilegedPath() public view {
        _assertStateMachineOnly(address(nativeVault), "NativeAssetVault");
        _assertStateMachineOnly(address(ercVault), "ERC20AssetVault");
    }

    /// The factory legitimately uses CREATE2 (one vault per asset) and nothing else.
    function test_FactoryOnlyCreates() public view {
        Scan memory s = _scan(address(factory), _adminSelectors());
        assertFalse(s.delegatecall, "factory: DELEGATECALL present");
        assertFalse(s.callcode, "factory: CALLCODE present");
        assertFalse(s.selfdestruct, "factory: SELFDESTRUCT present");
        assertFalse(s.create, "factory: CREATE present (must be CREATE2)");
        assertTrue(s.create2, "factory deploys vaults with CREATE2");
    }

    /// Periphery (private-swap spec §11): the escrow is a plain state machine; the factory only CREATE2s.
    function test_SwapPeripheryHasNoPrivilegedPath() public {
        SwapOrderFactory f = new SwapOrderFactory();
        Scan memory fs = _scan(address(f), _adminSelectors());
        assertFalse(fs.delegatecall || fs.callcode || fs.selfdestruct || fs.create, "swap factory: privileged opcode");
        assertTrue(fs.create2, "swap factory deploys escrows with CREATE2");

        SwapOrderTypes.OrderParams memory p;
        p.orderId = keccak256("scan");
        p.amount = 1 ether;
        p.orderSigner = address(0xBEEF);
        p.refundVault = address(nativeVault);
        p.executeDeadline = uint64(block.timestamp + 1);
        p.refundAfter = uint64(block.timestamp + 2);
        _assertStateMachineOnly(address(f.deploy(p)), "SwapOrderEscrow");
    }

    /// The walker itself is sound: it does find the opcodes when they are really there.
    function test_WalkerDetectsOpcodes() public {
        PrivilegedFixture p = new PrivilegedFixture();
        Scan memory s = _scan(address(p), new bytes4[](0));
        assertTrue(s.delegatecall && s.selfdestruct, "walker misses real DELEGATECALL / SELFDESTRUCT");
    }
}

/// A deliberately privileged contract, only to prove the scanner catches what it should.
contract PrivilegedFixture {
    function upgrade(address impl, bytes calldata data) external {
        (bool ok,) = impl.delegatecall(data);
        require(ok);
    }

    function kill() external {
        assembly {
            selfdestruct(caller())
        }
    }
}
