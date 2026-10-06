// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PPTestBase} from "../PPTestBase.sol";
import {PrivacyCore} from "../../src/core/PrivacyCore.sol";
import {CoreTypes} from "../../src/core/CoreTypes.sol";
import {NativeAssetVault} from "../../src/vault/NativeAssetVault.sol";
import {ERC20AssetVault} from "../../src/vault/ERC20AssetVault.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";

/// Randomized handler that performs only VALID deposits/withdrawals across TWO vaults (ETH and an
/// ERC-20; the verifier is set to acceptAll). It exercises the core/vault state machine so the
/// invariants are checked across many fuzzed sequences, including cross-vault ones.
contract Handler {
    uint256 internal constant FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    PrivacyCore internal immutable core;
    NativeAssetVault internal immutable eth;
    ERC20AssetVault internal immutable erc;
    ERC20Mock internal immutable tok;
    uint256 public n = 1; // monotonic source of distinct nullifiers / commitments
    bytes internal noteData = new bytes(CoreTypes.NOTE_DATA_BYTES);

    constructor(PrivacyCore c, NativeAssetVault v, ERC20AssetVault e, ERC20Mock t) {
        core = c;
        eth = v;
        erc = e;
        tok = t;
    }

    receive() external payable {}

    function depositNative(uint256 seed) external {
        uint256 amt = (seed % 3 ether) + 1;
        if (address(this).balance < amt) return;
        eth.deposit{value: amt}(uint256(keccak256(abi.encode("oc", n++))) % FIELD, n++, noteData);
    }

    function depositERC20(uint256 seed) external {
        uint256 amt = (seed % 1000e18) + 1;
        tok.mint(address(this), amt);
        tok.approve(address(erc), amt);
        erc.deposit(amt, uint256(keccak256(abi.encode("oc", n++))) % FIELD, n++, noteData);
    }

    function _withdraw(address vault, uint256 acc, uint256 seed) internal {
        if (acc == 0) return;
        CoreTypes.PublicInputs memory pi;
        pi.root = uint256(core.currentRoot());
        pi.nullifier0 = n++;
        pi.nullifier1 = n++;
        pi.outputBody0 = n++;
        pi.outputBody1 = n++;
        pi.outputBody2 = n++;
        pi.mode = 1;
        pi.withdrawalVault = uint256(uint160(vault));
        pi.withdrawalAmount = (seed % acc) + 1; // in [1, acc]
        pi.withdrawalRecipient = uint256(uint160(address(this)));
        uint256 h = core.noteDataHash(noteData);
        pi.noteData0Hash = h;
        pi.noteData1Hash = h;
        pi.noteData2Hash = h;
        pi.txDomain = core.TX_DOMAIN();
        core.transact("", pi, noteData, noteData, noteData);
    }

    function withdrawNative(uint256 seed) external {
        _withdraw(address(eth), eth.accountedDeposits(), seed);
    }

    function withdrawERC20(uint256 seed) external {
        _withdraw(address(erc), erc.accountedDeposits(), seed);
    }
}

contract InvariantsTest is PPTestBase {
    Handler internal handler;
    ERC20Mock internal tok;
    ERC20AssetVault internal ercVault;

    function setUp() public {
        _deployCore();
        verifier.setAcceptAll(true);
        tok = new ERC20Mock();
        ercVault = ERC20AssetVault(factory.getOrCreateERC20Vault(address(tok)));
        handler = new Handler(core, nativeVault, ercVault, tok);
        vm.deal(address(handler), 1_000_000 ether);
        _targetContract(address(handler));
    }

    /// Inv 1: the core is a pure state machine; it must NEVER custody ETH.
    function invariant_CoreHoldsNoETH() public view {
        assertEq(address(core).balance, 0);
    }

    /// Inv 2: nor any ERC-20.
    function invariant_CoreHoldsNoERC20() public view {
        assertEq(tok.balanceOf(address(core)), 0);
    }

    /// Vault solvency: every vault physically holds at least what it owes (shielded + claimable).
    function invariant_VaultsSolvent() public view {
        assertTrue(nativeVault.actualAssetBalance() >= nativeVault.accountedDeposits() + nativeVault.totalClaimable());
        assertTrue(ercVault.actualAssetBalance() >= ercVault.accountedDeposits() + ercVault.totalClaimable());
    }

    /// Inv 7 (accounting form): ETH liabilities are backed by ETH only and token liabilities by the
    /// token only — a release from one vault can never be paid from the other's balance.
    function invariant_NoCrossAssetBacking() public view {
        assertEq(tok.balanceOf(address(nativeVault)), 0);
        assertEq(address(ercVault).balance, 0);
    }

    /// The leaf cursor only ever advances in aligned groups.
    function invariant_LeafGroupsAligned() public view {
        assertEq(uint256(core.nextLeafIndex()) % core.GROUP_SIZE(), 0);
    }
}
