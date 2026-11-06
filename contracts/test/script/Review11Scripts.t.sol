// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "../utils/MiniTest.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {DeployShieldReceiver} from "../../script/DeployShieldReceiver.s.sol";
import {DeploySwapPeriphery} from "../../script/DeploySwapPeriphery.s.sol";
import {TransactionVerifierDev} from "../../src/verifier/dev/TransactionVerifierDev.sol";
import {Poseidon2Hasher} from "../../src/hasher/Poseidon2Hasher.sol";

interface VmScript {
    function chainId(uint256) external;
    function setEnv(string calldata name, string calldata value) external;
    function expectRevert(bytes calldata) external;
    function etch(address target, bytes calldata code) external;
    function toString(bytes32) external pure returns (string memory);
}

contract DeployHarness is Deploy {
    function holds(bytes memory code) external pure returns (bool) {
        return _holdsDevKey(code);
    }
}

contract SwapHarness is DeploySwapPeriphery {
    address internal named;
    bool internal naming;

    function wrapped() external view returns (address) {
        return _wrappedNativeOrRefuse();
    }

    function checked(address w) external view returns (address) {
        return _checkedWrappedNative(w);
    }

    /// what WRAPPED_NATIVE would name, for this harness alone
    function name(address w) external {
        (named, naming) = (w, true);
    }

    function _envWrappedNative() internal view override returns (address) {
        return naming ? named : super._envWrappedNative();
    }
}

contract ShieldHarness is DeployShieldReceiver {
    address internal named;
    bool internal naming;

    function wrapped() external view returns (address) {
        return _wrappedNativeOrRefuse();
    }

    function checked(address w) external view returns (address) {
        return _checkedWrappedNative(w);
    }

    /// what WRAPPED_NATIVE would name, for this harness alone
    function name(address w) external {
        (named, naming) = (w, true);
    }

    function _envWrappedNative() internal view override returns (address) {
        return naming ? named : super._envWrappedNative();
    }
}

/// The eleventh review round (2026-11-04): the deploy scripts. G11-4 — the development key is refused by its key, however it was compiled
/// (the code hash had recognised one compilation alone); G11-6 — the shield receiver factory takes the chain's wrapped native token by
/// default and never none off a devnet (a factory built on none let anyone sweep an ETH receipt's WETH to the public fallback).
contract Review11ScriptsTest is Test {
    VmScript internal constant vms = VmScript(address(uint160(uint256(keccak256("hevm cheat code")))));
    /// TransactionVerifierDev.sol's deltax1, deltay1, IC0x and IC0y: the development key's own words
    uint256 internal constant DELTA_X1 = 5194700165901174422425083130443367793879434620418714366739565157482437651080;
    uint256 internal constant DELTA_Y1 = 7774707056360511227688616772812096517276851137548054387646650221151862203494;
    uint256 internal constant IC0_X = 12490250489579078334468903666746122328520461107555501967769973561042847684859;
    uint256 internal constant IC0_Y = 16007219263561027990174618435951307649396127816619130167368978797914835735812;

    /// every byte-aligned run of `word` in `code` replaced by `by`
    function _replace(bytes memory code, uint256 word, bytes32 by) internal pure {
        for (uint256 i = 0; i + 32 <= code.length; i++) {
            uint256 w;
            assembly {
                w := mload(add(add(code, 32), i))
            }
            if (w == word) {
                assembly {
                    mstore(add(add(code, 32), i), by)
                }
            }
        }
    }

    function test_G11_4_theDevelopmentKeyIsRecognisedHoweverItWasCompiled() public {
        DeployHarness d = new DeployHarness();
        bytes memory dev = type(TransactionVerifierDev).runtimeCode;
        assertTrue(d.holds(dev), "the pinned build");
        // the same key with solc's default CBOR metadata trailer, as another toolchain builds it: another code hash, the same key
        bytes memory trailered = bytes.concat(dev, hex"a2646970667358221220", bytes32(uint256(7)), hex"64736f6c634300081c0033");
        assertTrue(keccak256(trailered) != keccak256(dev), "another code hash");
        assertTrue(d.holds(trailered), "recognised by its key");
        assertFalse(d.holds(type(Poseidon2Hasher).runtimeCode), "code without the key passes");
    }

    /// Another key of the same template is not the development key (the second critique of slice 5: the script keeps its own copy of two
    /// of the key's words, and a word every snarkjs verifier embeds — the G2 generator's — in their place had refused every ceremony key).
    function test_G11_4_anotherKeyOfTheSameTemplateIsNotTheDevelopmentKey() public {
        DeployHarness d = new DeployHarness();
        bytes memory code = type(TransactionVerifierDev).runtimeCode;
        uint256[4] memory words = [DELTA_X1, DELTA_Y1, IC0_X, IC0_Y];
        for (uint256 k = 0; k < 4; k++) _replace(code, words[k], keccak256(abi.encode(words[k])));
        assertFalse(d.holds(code), "another ceremony's key in the same template");
        assertTrue(d.holds(type(TransactionVerifierDev).runtimeCode), "the development key itself");
    }

    /// run() itself, not only its helper (the first critique of slice 5): an operator who names the recompiled development key and its own
    /// code hash on mainnet is refused before anything is deployed.
    function test_G11_4_runRefusesTheRecompiledDevelopmentKeyOffADevnet() public {
        bytes memory trailered = bytes.concat(type(TransactionVerifierDev).runtimeCode, hex"a2646970667358221220", bytes32(uint256(7)), hex"64736f6c634300081c0033");
        address inner = address(0x1234567890123456789012345678901234567890);
        vms.etch(inner, trailered);
        vms.chainId(1);
        vms.setEnv("INNER_VERIFIER", "0x1234567890123456789012345678901234567890");
        vms.setEnv("INNER_VERIFIER_CODEHASH", vms.toString(keccak256(trailered)));
        Deploy d = new Deploy();
        vms.expectRevert(
            bytes("INNER_VERIFIER embeds the development key, however it was compiled: only DEV_VERIFIER (chain id 31337) or SEPOLIA_DEV_VERIFIER (Sepolia) deploys it")
        );
        d.run();
        vms.chainId(31337);
    }

    /// Where the wallet pins the chain's wrapped native token (mainnet, Sepolia), an override other than that one is refused before an immutable
    /// factory exists (the second critique of slice 5), by both scripts; elsewhere the operator's token is taken.
    function test_G11_6_anOverrideOtherThanTheChainsOwnIsRefusedWhereTheWalletPinsOne() public {
        ShieldHarness s = new ShieldHarness();
        SwapHarness w = new SwapHarness();
        address weth9 = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
        address other = address(0xBEEF);
        bytes memory refused = bytes("WRAPPED_NATIVE: on mainnet and Sepolia only the chain's own WETH, as the wallet's deployment check requires");
        vms.chainId(1);
        assertEq(s.checked(weth9), weth9, "mainnet: WETH9 itself");
        vms.expectRevert(refused);
        s.checked(other);
        vms.expectRevert(refused);
        w.checked(other);
        vms.chainId(11155111);
        vms.expectRevert(refused);
        s.checked(other);
        vms.chainId(8453);
        assertEq(w.checked(other), other, "a chain the wallet names none for: the operator's");
        vms.chainId(31337);
    }

    /// The run path with an operator's override (the third critique of slice 5: the helper alone had a test, and a run path that took the
    /// override past it passed every test): on mainnet and Sepolia another token is refused and the chain's own taken; elsewhere the
    /// operator's.
    function test_G11_6_theRunPathRefusesAnOverrideOtherThanTheChainsOwn() public {
        ShieldHarness s = new ShieldHarness();
        SwapHarness w = new SwapHarness();
        address weth9 = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
        address sepoliaWeth = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
        address other = address(0xBEEF);
        bytes memory refused = bytes("WRAPPED_NATIVE: on mainnet and Sepolia only the chain's own WETH, as the wallet's deployment check requires");
        s.name(other);
        w.name(other);
        vms.chainId(1);
        vms.expectRevert(refused);
        s.wrapped();
        vms.expectRevert(refused);
        w.wrapped();
        vms.chainId(11155111);
        vms.expectRevert(refused);
        s.wrapped();
        vms.expectRevert(refused);
        w.wrapped();
        vms.chainId(8453);
        assertEq(s.wrapped(), other, "a chain the wallet names none for: the operator's");
        assertEq(w.wrapped(), other, "a chain the wallet names none for: the operator's");
        s.name(weth9);
        w.name(weth9);
        vms.chainId(1);
        assertEq(s.wrapped(), weth9, "mainnet: WETH9 named");
        assertEq(w.wrapped(), weth9, "mainnet: WETH9 named");
        vms.chainId(11155111);
        vms.expectRevert(refused);
        w.wrapped(); // WETH9 is not Sepolia's
        s.name(sepoliaWeth);
        assertEq(s.wrapped(), sepoliaWeth, "Sepolia: its WETH named");
        vms.chainId(31337);
    }

    /// The swap periphery's script refuses none off a devnet too (the first critique of slice 5), as the wallet's check does.
    function test_G11_6_theSwapFactoryTakesTheChainsWrappedNative_neverNoneOffADevnet() public {
        SwapHarness s = new SwapHarness();
        vms.chainId(1);
        assertEq(s.wrapped(), 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2, "mainnet: WETH9");
        vms.chainId(31337);
        assertEq(s.wrapped(), address(0), "a devnet: none is allowed");
        vms.chainId(5);
        vms.expectRevert(bytes("WRAPPED_NATIVE: the chain's wrapped native token (none only on a devnet, chain id 31337)"));
        s.wrapped();
        vms.expectRevert(bytes("WRAPPED_NATIVE: the chain's wrapped native token (none only on a devnet, chain id 31337)"));
        s.run();
        vms.chainId(31337);
    }

    function test_G11_6_theShieldFactoryTakesTheChainsWrappedNative_neverNoneOffADevnet() public {
        ShieldHarness s = new ShieldHarness();
        // what run() deploys the factory with, WRAPPED_NATIVE unset
        vms.chainId(1);
        assertEq(s.wrapped(), 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2, "mainnet: WETH9");
        vms.chainId(11155111);
        assertEq(s.wrapped(), 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14, "Sepolia: its WETH");
        vms.chainId(31337);
        assertEq(s.wrapped(), address(0), "a devnet: none is allowed");
        // a chain without a default: refused, by run() itself before anything is deployed
        vms.chainId(5);
        vms.expectRevert(bytes("WRAPPED_NATIVE: the chain's wrapped native token (none only on a devnet, chain id 31337)"));
        s.wrapped();
        vms.setEnv("CORE", "0x0000000000000000000000000000000000000001");
        vms.expectRevert(bytes("WRAPPED_NATIVE: the chain's wrapped native token (none only on a devnet, chain id 31337)"));
        s.run();
        vms.chainId(31337);
    }
}
