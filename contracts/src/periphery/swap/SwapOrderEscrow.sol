// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SwapOrderTypes as T} from "./SwapOrderTypes.sol";
import {ReentrancyGuard} from "../../utils/ReentrancyGuard.sol";
import {IERC20} from "../../vault/IERC20.sol";

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

interface ISwapOrderFactoryConfig {
    function WRAPPED_NATIVE() external view returns (address);
}

/// The pool a refund vault belongs to, and that pool's permissionless vault factory (one canonical vault per token).
interface IVaultCoreLink {
    function core() external view returns (address);
}

interface ICoreVaultFactory {
    function VAULT_FACTORY() external view returns (address);
}

interface IVaultFactory {
    function getOrCreateNativeVault() external returns (address);
    function getOrCreateERC20Vault(address token) external returns (address);
}

/// @title SwapOrderEscrow — one-time source endpoint for a private cross-chain swap (spec §6, §7, §11)
/// @notice PERIPHERY, never core. A private withdrawal pays this counterfactual address; anyone (a
/// relayer) then deploys it and runs `execute` with an execution signed by the order's one-time key,
/// which forwards the funds to the chosen provider with the signed calldata before the signed
/// deadline. If that never happens — or the provider refunds here — anyone may `refund` after
/// `refundAfter`, which re-shields the whole balance into our canonical vault as the pre-committed
/// fresh note. The user's permanent address never appears, the user signs nothing with a public key
/// that is ever reused, and a provider can never reach more than this one order's balance. An ETH
/// order unwraps any wrapped native token it was paid back in before re-shielding; any other token a
/// provider pays back (a route that swapped first refunds in the swapped token) re-shields into that
/// token's canonical vault through `refundToken`. Token calls accept tokens that return nothing (USDT).
/// No owner, no setters, no upgrade.
contract SwapOrderEscrow is ReentrancyGuard {
    bytes32 public immutable ORDER_ID;
    uint8 public immutable ASSET_TYPE;
    address public immutable ASSET;
    uint256 public immutable AMOUNT;
    address public immutable ORDER_SIGNER;
    uint64 public immutable EXECUTE_DEADLINE;
    uint64 public immutable REFUND_AFTER;
    address public immutable REFUND_VAULT;
    uint256 public immutable REFUND_OWNER_COMMITMENT;
    uint256 public immutable REFUND_NOTE_SECRET;
    bytes32 public immutable REFUND_NOTE_DATA_HASH;
    uint256 public immutable EXECUTOR_TIP;
    /// @notice The chain's wrapped native token, from the deploying factory (address(0) if none).
    address public immutable WRAPPED_NATIVE;

    bool public executed;
    bool public tipPaid;

    event Executed(address indexed provider, uint256 value, bytes32 calldataHash, address executor);
    event Refunded(address indexed vault, uint256 amount, address executor);

    constructor(T.OrderParams memory p) {
        if (p.executorTip > p.amount / T.TIP_DIVISOR) revert T.TipTooLarge();
        if (p.refundAfter < p.executeDeadline) revert T.BadDeadlines();
        if (p.orderSigner == address(0)) revert T.ZeroSigner();
        ORDER_ID = p.orderId;
        ASSET_TYPE = p.assetType;
        ASSET = p.asset;
        AMOUNT = p.amount;
        ORDER_SIGNER = p.orderSigner;
        EXECUTE_DEADLINE = p.executeDeadline;
        REFUND_AFTER = p.refundAfter;
        REFUND_VAULT = p.refundVault;
        REFUND_OWNER_COMMITMENT = p.refundOwnerCommitment;
        REFUND_NOTE_SECRET = p.refundNoteSecret;
        REFUND_NOTE_DATA_HASH = p.refundNoteDataHash;
        EXECUTOR_TIP = p.executorTip;
        // read from the factory (the only deployer), so OrderParams and the CREATE2 address formula stay as they are
        WRAPPED_NATIVE = ISwapOrderFactoryConfig(msg.sender).WRAPPED_NATIVE();
    }

    /// @dev The private withdrawal (vault.release), provider refunds and unwrapped WETH land here. It must
    /// stay this cheap: THORChain's router refunds with `send` (2300 gas), Chainflip's Vault and WETH9
    /// forward 8,000 / 2300 (test_ProviderRefund_FitsTheGasStipendsProvidersForward).
    receive() external payable {}

    function balance() public view returns (uint256) {
        return ASSET_TYPE == T.ASSET_ETH ? address(this).balance : IERC20(ASSET).balanceOf(address(this));
    }

    /// @notice The message the one-time order key signs to authorize exactly one provider call.
    function executionDigest(address provider, uint256 value, bytes32 calldataHash, uint64 deadline) public view returns (bytes32) {
        return keccak256(abi.encode(T.EXECUTE_TAG, block.chainid, address(this), ORDER_ID, provider, value, calldataHash, deadline));
    }

    /// @notice Forward the order to the provider named in a signed execution. Anyone may submit it;
    /// only the order key can author it, so the limit / destination inside the calldata, the provider
    /// and the value are the wallet's choice, not the relayer's. `tipRecipient` gets the committed tip.
    function execute(T.Execution calldata x, address tipRecipient) external nonReentrant {
        if (executed) revert T.AlreadyExecuted();
        if (x.deadline > EXECUTE_DEADLINE) revert T.DeadlineTooLate();
        if (block.timestamp > x.deadline) revert T.DeadlinePassed();
        bytes32 cdHash = keccak256(x.providerCalldata);
        if (_recover(executionDigest(x.provider, x.value, cdHash, x.deadline), x.signature) != ORDER_SIGNER) revert T.BadSignature();
        if (balance() < AMOUNT) revert T.NotFunded();
        executed = true;
        _payTip(tipRecipient);
        bool ok;
        if (ASSET_TYPE == T.ASSET_ETH) {
            if (x.value > address(this).balance) revert T.ValueTooLarge();
            (ok,) = x.provider.call{value: x.value}(x.providerCalldata);
        } else {
            if (x.value != 0) revert T.ValueTooLarge();
            // the provider pulls the tokens inside its call (standard router pattern)
            ok = _approve(ASSET, x.provider, IERC20(ASSET).balanceOf(address(this)));
            if (ok) (ok,) = x.provider.call(x.providerCalldata);
        }
        if (!ok) revert T.ProviderCallFailed();
        emit Executed(x.provider, x.value, cdHash, tipRecipient);
    }

    /// @notice After `refundAfter`, re-shield whatever is here into our vault as the committed fresh
    /// note. Covers: never executed (quote expired, provider down), provider-level refunds that landed
    /// here, and dust after a partial fill. The payload must hash to the committed value, so a relayer
    /// cannot substitute the recipient's encrypted note.
    function refund(bytes calldata noteData, address tipRecipient) external nonReentrant {
        if (block.timestamp < REFUND_AFTER) revert T.TooEarlyToRefund();
        if (keccak256(noteData) != REFUND_NOTE_DATA_HASH) revert T.NoteDataMismatch();
        _unwrapNative();
        _payTip(tipRecipient);
        uint256 amt = balance();
        if (amt == 0) revert T.NothingToRefund();
        if (ASSET_TYPE == T.ASSET_ETH) {
            INativeVaultDeposit(REFUND_VAULT).deposit{value: amt}(REFUND_OWNER_COMMITMENT, REFUND_NOTE_SECRET, noteData);
        } else {
            if (!_approve(ASSET, REFUND_VAULT, amt)) revert T.TokenCallFailed();
            IERC20VaultDeposit(REFUND_VAULT).deposit(amt, REFUND_OWNER_COMMITMENT, REFUND_NOTE_SECRET, noteData);
        }
        emit Refunded(REFUND_VAULT, amt, tipRecipient);
    }

    /// @notice After `refundAfter`, re-shield what a provider paid back in something other than this
    /// order's asset: a route that swaps first and bridges the result refunds an unfilled deposit in the
    /// swapped token. A token goes into its canonical vault in the same pool as the committed refund
    /// vault (created on demand by the pool's permissionless factory). An ERC-20 order paid back in the
    /// wrapped native token has it unwrapped, and it re-shields as ETH into the pool's native vault, as
    /// does ETH that lands at such an escrow (`token == address(0)`), which nothing else could move.
    /// Each lands as a note with the pre-committed owner and secret. The order's asset, and an ETH
    /// order's ETH and wrapped native token, re-shield through `refund()`. No tip: it was paid with the
    /// order's asset.
    function refundToken(address token, bytes calldata noteData) external nonReentrant {
        if (block.timestamp < REFUND_AFTER) revert T.TooEarlyToRefund();
        if (keccak256(noteData) != REFUND_NOTE_DATA_HASH) revert T.NoteDataMismatch();
        if (token == ASSET || (ASSET_TYPE == T.ASSET_ETH && (token == address(0) || token == WRAPPED_NATIVE))) {
            revert T.NotAForeignToken();
        }
        IVaultFactory vaults = IVaultFactory(ICoreVaultFactory(IVaultCoreLink(REFUND_VAULT).core()).VAULT_FACTORY());
        if (token == address(0) || token == WRAPPED_NATIVE) {
            // strict here: a wrapped token that fails to unwrap reverts this call only; the ETH already
            // here still re-shields through refundToken(address(0))
            if (token != address(0)) {
                uint256 wrapped = IWrappedNative(token).balanceOf(address(this));
                if (wrapped != 0) IWrappedNative(token).withdraw(wrapped);
            }
            uint256 eth = address(this).balance;
            if (eth == 0) revert T.NothingToRefund();
            address nativeVault = vaults.getOrCreateNativeVault();
            INativeVaultDeposit(nativeVault).deposit{value: eth}(REFUND_OWNER_COMMITMENT, REFUND_NOTE_SECRET, noteData);
            emit Refunded(nativeVault, eth, msg.sender);
            return;
        }
        uint256 amt = IERC20(token).balanceOf(address(this));
        if (amt == 0) revert T.NothingToRefund();
        address vault = vaults.getOrCreateERC20Vault(token);
        if (!_approve(token, vault, amt)) revert T.TokenCallFailed();
        IERC20VaultDeposit(vault).deposit(amt, REFUND_OWNER_COMMITMENT, REFUND_NOTE_SECRET, noteData);
        emit Refunded(vault, amt, msg.sender);
    }

    /// @dev An ETH order may be paid back wrapped (an unfilled Across deposit is refunded to its depositor
    /// in WETH): unwrap it so the whole value re-shields as ETH. A wrapped token that misbehaves is
    /// skipped, never allowed to block the ETH refund; the WETH can be unwrapped by a later refund().
    function _unwrapNative() private {
        address w = WRAPPED_NATIVE;
        if (ASSET_TYPE != T.ASSET_ETH || w.code.length == 0) return;
        try IWrappedNative(w).balanceOf(address(this)) returns (uint256 wrapped) {
            if (wrapped != 0) {
                try IWrappedNative(w).withdraw(wrapped) {} catch {}
            }
        } catch {}
    }

    function _payTip(address to) private {
        if (tipPaid || EXECUTOR_TIP == 0) return;
        // nothing to tip from (a dust refund) — and a balance of exactly the tip re-shields whole, untipped: paying it
        // would leave nothing to deposit and revert the refund until someone added a wei
        if (balance() <= EXECUTOR_TIP) return;
        tipPaid = true;
        if (ASSET_TYPE == T.ASSET_ETH) {
            (bool ok,) = payable(to).call{value: EXECUTOR_TIP}("");
            if (!ok) revert T.TipTransferFailed();
        } else {
            if (!_transfer(ASSET, to, EXECUTOR_TIP)) revert T.TipTransferFailed();
        }
    }

    /// @dev Token calls that accept an empty return (USDT-like tokens, which the pool's vaults support)
    /// and refuse an explicit false (PP-S10: typed calls expecting a bool reverted on USDT, so such an
    /// order could neither execute nor refund).
    function _approve(address token, address spender, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        return ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))));
    }

    function _transfer(address token, address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        return ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))));
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        // reject malleable high-s signatures
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
