// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPrivacyCore} from "../../core/IPrivacyCore.sol";
import {IAssetVaultFactory} from "../../factory/IAssetVaultFactory.sol";
import {IERC20} from "../../vault/IERC20.sol";
import {ReentrancyGuard} from "../../utils/ReentrancyGuard.sol";

interface INativeVaultDeposit {
    function deposit(uint256 ownerCommitment, uint256 noteSecret, bytes calldata noteData) external payable returns (uint32);
}

interface IERC20VaultDeposit {
    function deposit(uint256 amount, uint256 ownerCommitment, uint256 noteSecret, bytes calldata noteData) external returns (uint32);
}

/// @title ProtectRouter — the privacy fee on a protect (Privacy Wallet Web spec v2.0 §3, §11.1)
/// @notice A protect through the wallet pays 1 % of what it puts in: `fee = ⌈gross · 100 / 10000⌉` goes to the fee
/// recipient, the rest (`net`) is deposited into the asset's canonical vault as the note the wallet built for `net`.
/// Periphery: it calls the vaults' public `deposit` like any user — PrivacyCore and the vaults are unchanged and do
/// not know it. No owner, no setters, no upgrade path, no funds held between calls; the vault always comes from the
/// factory's `vaultOf` (the router never creates one). The fee recipient is public, as the deposit already was.
/// A direct vault deposit bypasses the fee (a stated gap: the official wallet always uses the router).
contract ProtectRouter is ReentrancyGuard {
    /// @notice The privacy fee in basis points of the gross amount: 1.00 %.
    uint256 public constant FEE_BPS = 100;
    uint256 private constant BPS = 10_000;

    address public immutable CORE;
    address public immutable VAULT_FACTORY;
    address public immutable FEE_RECIPIENT;

    event Protected(address indexed asset, address indexed vault, uint256 gross, uint256 fee, uint32 leafIndex);

    error ZeroAddress();
    error FactoryMismatch();
    error NoVault();
    error ZeroAmount();
    error AmountMismatch(uint256 net, uint256 expectedNet);
    error TokenTransferFailed();
    error UnsupportedToken();
    error FeeTransferFailed();

    constructor(address core, address feeRecipient) {
        if (core == address(0) || feeRecipient == address(0)) revert ZeroAddress();
        address vaultFactory = IPrivacyCore(core).VAULT_FACTORY();
        if (vaultFactory == address(0) || IAssetVaultFactory(vaultFactory).CORE() != core) revert FactoryMismatch();
        CORE = core;
        VAULT_FACTORY = vaultFactory;
        FEE_RECIPIENT = feeRecipient;
    }

    /// @notice `⌈gross · FEE_BPS / 10000⌉`, exact for every uint256 (no intermediate overflow).
    function feeOf(uint256 gross) public pure returns (uint256) {
        uint256 q = gross / BPS;
        uint256 r = gross % BPS;
        return q * FEE_BPS + (r * FEE_BPS + BPS - 1) / BPS;
    }

    /// @notice Protect `msg.value` ETH: the fee to the recipient, `msg.value − fee` as the caller's note.
    /// @param expectedNet the amount the wallet built the note (and its encrypted payload) for; it must equal the net.
    function protectETH(uint256 ownerCommitment, uint256 noteSecret, bytes calldata noteData, uint256 expectedNet)
        external
        payable
        nonReentrant
        returns (uint32 leafIndex)
    {
        address vault = IAssetVaultFactory(VAULT_FACTORY).vaultOf(address(0));
        if (vault == address(0)) revert NoVault();
        (uint256 fee, uint256 net) = _split(msg.value, expectedNet);
        (bool paid,) = payable(FEE_RECIPIENT).call{value: fee}("");
        if (!paid) revert FeeTransferFailed();
        leafIndex = INativeVaultDeposit(vault).deposit{value: net}(ownerCommitment, noteSecret, noteData);
        emit Protected(address(0), vault, msg.value, fee, leafIndex);
    }

    /// @notice Protect `gross` of `token`: pulled from the caller (who approved this router for exactly `gross`), the fee
    /// to the recipient, `gross − fee` deposited as the caller's note. A token that does not move exactly what it is
    /// asked to (fee-on-transfer, rebasing) is refused, as the vault refuses it.
    function protectERC20(
        address token,
        uint256 gross,
        uint256 ownerCommitment,
        uint256 noteSecret,
        bytes calldata noteData,
        uint256 expectedNet
    ) external nonReentrant returns (uint32 leafIndex) {
        if (token == address(0)) revert NoVault(); // the native asset goes through protectETH
        address vault = IAssetVaultFactory(VAULT_FACTORY).vaultOf(token);
        if (vault == address(0)) revert NoVault();
        (uint256 fee, uint256 net) = _split(gross, expectedNet);

        uint256 before = IERC20(token).balanceOf(address(this));
        _strictCall(token, abi.encodeWithSelector(IERC20.transferFrom.selector, msg.sender, address(this), gross));
        if (IERC20(token).balanceOf(address(this)) - before != gross) revert UnsupportedToken();

        if (!_softCall(token, abi.encodeWithSelector(IERC20.transfer.selector, FEE_RECIPIENT, fee))) revert FeeTransferFailed();
        _strictCall(token, abi.encodeWithSelector(IERC20.approve.selector, vault, net));
        leafIndex = IERC20VaultDeposit(vault).deposit(net, ownerCommitment, noteSecret, noteData);
        // the vault pulled exactly `net`: nothing stays here, not even an allowance
        if (IERC20(token).balanceOf(address(this)) != before) revert UnsupportedToken();
        emit Protected(token, vault, gross, fee, leafIndex);
    }

    function _split(uint256 gross, uint256 expectedNet) private pure returns (uint256 fee, uint256 net) {
        if (gross == 0) revert ZeroAmount();
        fee = feeOf(gross);
        net = gross - fee; // fee ≤ gross for every gross ≥ 1
        if (net == 0) revert ZeroAmount();
        if (net != expectedNet) revert AmountMismatch(net, expectedNet);
    }

    /// @dev Revert on a reverting token, a `false` return, or a non-standard return shape (no return value is accepted:
    /// USDT-style tokens return nothing).
    function _strictCall(address token, bytes memory data) private {
        if (!_softCall(token, data)) revert TokenTransferFailed();
    }

    function _softCall(address token, bytes memory data) private returns (bool) {
        if (token.code.length == 0) return false;
        (bool success, bytes memory ret) = token.call(data);
        return success && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))));
    }
}
