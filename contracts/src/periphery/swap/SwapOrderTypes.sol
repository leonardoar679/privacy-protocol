// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SwapOrderTypes — the one-time source endpoint's parameters (private-swap spec §6)
library SwapOrderTypes {
    uint8 internal constant ASSET_ETH = 0;
    uint8 internal constant ASSET_ERC20 = 1;
    /// executorTip MUST be <= amount / TIP_DIVISOR (1%).
    uint256 internal constant TIP_DIVISOR = 100;
    /// Domain tag of the execution authorization signed by the order key.
    bytes32 internal constant EXECUTE_TAG = keccak256("privacy-protocol/v1.1/swap-order/execute");

    /// Everything the escrow commits to. Its CREATE2 address is a function of these values, so a
    /// private withdrawal to the predicted address funds exactly this order and nothing else. The
    /// provider call itself is NOT committed here: it is authorized later by a signature from the
    /// one-time `orderSigner`, so the escrow address is known before the quote and a funded order
    /// can be re-routed to a fallback provider without touching the chain (plan §57).
    struct OrderParams {
        bytes32 orderId; // random, unique; the CREATE2 salt
        uint8 assetType; // 0 = ETH, 1 = ERC-20
        address asset; // token for ERC-20 orders, address(0) for ETH
        uint256 amount; // expected funding (the private withdrawal amount)
        address orderSigner; // one-time key that authorizes the provider call (wallet-derived, never reused)
        uint64 executeDeadline; // latest time an execution may be authorized (the quote's expiry is <= this)
        uint64 refundAfter; // >= executeDeadline; refund() is allowed from here
        address refundVault; // our canonical vault for `asset`: the refund re-shields there
        uint256 refundOwnerCommitment; // the fresh note the refund becomes
        uint256 refundNoteSecret;
        bytes32 refundNoteDataHash; // keccak256 of the 169-byte payload supplied at refund time
        uint256 executorTip; // paid to whoever executes or refunds (relayer incentive)
    }

    /// What the order key signs: keccak256(abi.encode(EXECUTE_TAG, chainId, escrow, orderId, provider,
    /// value, keccak256(calldata), deadline)). `deadline` <= executeDeadline is the quote's expiry.
    struct Execution {
        address provider; // router / deposit contract, or the plain deposit address
        uint256 value; // ETH to forward (ETH orders); 0 for ERC-20 (the provider pulls)
        bytes providerCalldata; // exact calldata; carries the minimum output where the provider supports it
        uint64 deadline;
        bytes signature; // 65-byte secp256k1 signature by orderSigner
    }

    error TipTooLarge();
    error BadDeadlines();
    error ZeroSigner();
    error NotFunded();
    error DeadlinePassed();
    error DeadlineTooLate();
    error TooEarlyToRefund();
    error BadSignature();
    error ValueTooLarge();
    error NoteDataMismatch();
    error AlreadyExecuted();
    error ProviderCallFailed();
    error NothingToRefund();
    error TipTransferFailed();
    error TokenCallFailed();
    error NotAForeignToken();
}
