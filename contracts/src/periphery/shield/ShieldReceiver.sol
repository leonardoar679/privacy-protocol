// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ShieldReceiverTypes as T} from "./ShieldReceiverTypes.sol";
import {IAssetVaultFactory} from "../../factory/IAssetVaultFactory.sol";
import {IERC20} from "../../vault/IERC20.sol";
import {ReentrancyGuard} from "../../utils/ReentrancyGuard.sol";

interface INativeVaultDeposit {
    function deposit(uint256 ownerCommitment, uint256 noteSecret, bytes calldata noteData) external payable returns (uint32);
}

interface IERC20VaultDeposit {
    function deposit(uint256 amount, uint256 ownerCommitment, uint256 noteSecret, bytes calldata noteData) external returns (uint32);
}

interface IWrappedNative {
    function balanceOf(address owner) external view returns (uint256);
    function withdraw(uint256 amount) external;
}

interface IShieldReceiverFactoryConfig {
    function VAULT_FACTORY() external view returns (address);
    function WRAPPED_NATIVE() external view returns (address);
}

/// @title ShieldReceiver — a same-chain swap's one-time destination (Privacy Wallet Web spec v2.0 §11.2)
/// @notice PERIPHERY. A swap of the protected balance into another asset of the pool's chain names this counterfactual
/// address as its destination: the provider pays the output here (THORChain's router with a 2300-gas `send`, before or
/// after deployment), and anyone — the relayer — then deploys it and `shield`s the balance into the asset's canonical
/// vault as the note the wallet committed (its owner, its secret, the hash of its payload). The relayer is paid the
/// committed tip once, and only when a delivery of at least the swap's minimum is shielded, so dust cannot claim it. An
/// ETH receipt unwraps wrapped ETH first. Another token that arrives goes into its own canonical vault (when one exists)
/// as the same note; ETH or wrapped ETH at a token receipt shields as ETH into the pool's native vault as the same note;
/// a token with no vault can only be swept to the committed fallback, a fresh address of the wallet — never ETH, never
/// wrapped ETH (the pool's own asset in another form), never the receipt's asset. Provider refunds still go to the swap's
/// escrow. No owner, no setters, no upgrade; it never creates a vault.
contract ShieldReceiver is ReentrancyGuard {
    bytes32 public immutable RECEIPT_ID;
    address public immutable ASSET;
    uint256 public immutable MIN_AMOUNT;
    uint256 public immutable SHIELD_TIP;
    uint256 public immutable OWNER_COMMITMENT;
    uint256 public immutable NOTE_SECRET;
    bytes32 public immutable NOTE_DATA_HASH;
    address public immutable FALLBACK_RECIPIENT;
    /// @notice The pool's vault factory and the chain's wrapped native token, from the deploying factory.
    address public immutable VAULT_FACTORY;
    address public immutable WRAPPED_NATIVE;

    bool public tipPaid;

    event Shielded(address indexed vault, uint256 amount, uint256 tip, uint32 leafIndex, address shielder);
    event Swept(address indexed token, uint256 amount, address recipient);

    constructor(T.ReceiverParams memory p) {
        if (p.minAmount == 0) revert T.ZeroMinimum();
        if (p.shieldTip > p.minAmount / T.TIP_DIVISOR) revert T.TipTooLarge();
        if (p.fallbackRecipient == address(0)) revert T.ZeroFallback();
        RECEIPT_ID = p.receiptId;
        ASSET = p.asset;
        MIN_AMOUNT = p.minAmount;
        SHIELD_TIP = p.shieldTip;
        OWNER_COMMITMENT = p.ownerCommitment;
        NOTE_SECRET = p.noteSecret;
        NOTE_DATA_HASH = p.noteDataHash;
        FALLBACK_RECIPIENT = p.fallbackRecipient;
        // read from the factory (the only deployer), so the params and the CREATE2 address formula stay as they are
        VAULT_FACTORY = IShieldReceiverFactoryConfig(msg.sender).VAULT_FACTORY();
        WRAPPED_NATIVE = IShieldReceiverFactoryConfig(msg.sender).WRAPPED_NATIVE();
    }

    /// @dev Deliveries land here. It must stay this cheap: THORChain's router pays ETH with `send` (2300 gas), WETH9's
    /// `withdraw` forwards 2300.
    receive() external payable {}

    /// @notice What this receiver holds of its asset now.
    function balance() public view returns (uint256) {
        return ASSET == address(0) ? address(this).balance : IERC20(ASSET).balanceOf(address(this));
    }

    /// @notice Shield what arrived into the asset's canonical vault as the committed note. `tipRecipient` gets the
    /// committed tip, once, and only when the balance shielded is at least the swap's minimum.
    function shield(bytes calldata noteData, address tipRecipient) external nonReentrant returns (uint32 leafIndex) {
        if (keccak256(noteData) != NOTE_DATA_HASH) revert T.NoteDataMismatch();
        address vault = IAssetVaultFactory(VAULT_FACTORY).vaultOf(ASSET);
        if (vault == address(0)) revert T.NoVault();
        if (ASSET == address(0)) _unwrapNative();
        uint256 amount = balance();
        if (amount == 0) revert T.NothingToShield();
        uint256 tip;
        if (!tipPaid && SHIELD_TIP != 0 && amount >= MIN_AMOUNT) {
            tipPaid = true;
            tip = SHIELD_TIP;
            if (ASSET == address(0)) {
                (bool ok,) = payable(tipRecipient).call{value: tip}("");
                if (!ok) revert T.TipTransferFailed();
            } else if (!_transfer(ASSET, tipRecipient, tip)) {
                revert T.TipTransferFailed();
            }
        }
        uint256 net = amount - tip;
        leafIndex = _deposit(ASSET, vault, net, noteData);
        emit Shielded(vault, net, tip, leafIndex, msg.sender);
    }

    /// @notice Shield another token that arrived (a route that paid in something else) into ITS canonical vault, when
    /// one exists, as the same committed note. No tip: the tip is the receipt's asset's. The receipt's own asset — and,
    /// for an ETH receipt, wrapped ETH — go through `shield`. At a token receipt, ETH (`token == address(0)`) and the
    /// wrapped native token are the pool's own asset in another form: the wrapped is unwrapped, and the ETH here goes into
    /// the pool's native vault as the same note — nothing else could move it, and the fallback never may.
    function shieldToken(address token, bytes calldata noteData) external nonReentrant returns (uint32 leafIndex) {
        if (keccak256(noteData) != NOTE_DATA_HASH) revert T.NoteDataMismatch();
        if (token == ASSET || (ASSET == address(0) && (token == address(0) || token == WRAPPED_NATIVE))) revert T.NotAForeignToken();
        if (token == address(0) || token == WRAPPED_NATIVE) {
            // strict here: a wrapped token that fails to unwrap reverts this call only; the ETH already here still
            // shields through shieldToken(address(0))
            if (token != address(0)) {
                uint256 wrapped = IWrappedNative(token).balanceOf(address(this));
                if (wrapped != 0) IWrappedNative(token).withdraw(wrapped);
            }
            uint256 eth = address(this).balance;
            if (eth == 0) revert T.NothingToShield();
            address nativeVault = IAssetVaultFactory(VAULT_FACTORY).vaultOf(address(0));
            if (nativeVault == address(0)) revert T.NoVault();
            leafIndex = _deposit(address(0), nativeVault, eth, noteData);
            emit Shielded(nativeVault, eth, 0, leafIndex, msg.sender);
            return leafIndex;
        }
        address vault = IAssetVaultFactory(VAULT_FACTORY).vaultOf(token);
        if (vault == address(0)) revert T.NoVault();
        uint256 amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert T.NothingToShield();
        leafIndex = _deposit(token, vault, amount, noteData);
        emit Shielded(vault, amount, 0, leafIndex, msg.sender);
    }

    /// @notice A token the pool has no vault for cannot be shielded: it can only go to the committed fallback, a fresh
    /// address of the wallet. Never a token with a vault, never ETH or the wrapped native token (the pool's own asset in
    /// another form: they shield), never the receipt's own asset.
    function sweepUnsupported(address token) external nonReentrant {
        if (token == address(0) || token == ASSET || token == WRAPPED_NATIVE) revert T.NotAForeignToken();
        if (IAssetVaultFactory(VAULT_FACTORY).vaultOf(token) != address(0)) revert T.VaultExists();
        uint256 amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert T.NothingToShield();
        if (!_transfer(token, FALLBACK_RECIPIENT, amount)) revert T.TokenCallFailed();
        emit Swept(token, amount, FALLBACK_RECIPIENT);
    }

    function _deposit(address token, address vault, uint256 amount, bytes calldata noteData) private returns (uint32) {
        if (token == address(0)) return INativeVaultDeposit(vault).deposit{value: amount}(OWNER_COMMITMENT, NOTE_SECRET, noteData);
        if (!_approve(token, vault, amount)) revert T.TokenCallFailed();
        return IERC20VaultDeposit(vault).deposit(amount, OWNER_COMMITMENT, NOTE_SECRET, noteData);
    }

    /// @dev An ETH receipt may be paid in wrapped ETH (a route that settles in WETH): unwrap it so the whole value
    /// shields as ETH. A wrapped token that misbehaves is skipped, never allowed to block the ETH already here.
    function _unwrapNative() private {
        address w = WRAPPED_NATIVE;
        if (w.code.length == 0) return;
        try IWrappedNative(w).balanceOf(address(this)) returns (uint256 wrapped) {
            if (wrapped != 0) {
                try IWrappedNative(w).withdraw(wrapped) {} catch {}
            }
        } catch {}
    }

    /// @dev Token calls that accept an empty return (USDT-like tokens) and refuse an explicit false.
    function _approve(address token, address spender, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        return ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))));
    }

    function _transfer(address token, address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        return ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))));
    }
}
