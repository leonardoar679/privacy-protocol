// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SwapOrderTypes as T} from "./SwapOrderTypes.sol";
import {SwapOrderEscrow} from "./SwapOrderEscrow.sol";

/// @title SwapOrderFactory — counterfactual CREATE2 deployer for SwapOrderEscrow (spec §6)
/// @notice Permissionless, ownerless, stateless. The escrow address is a pure function of the order
/// parameters, so a wallet can compute it off-chain (packages/swap-engine/src/endpoints.ts), fund it
/// with a private withdrawal, and let any relayer deploy + execute or deploy + refund later.
contract SwapOrderFactory {
    event OrderEscrowDeployed(bytes32 indexed orderId, address escrow);

    /// @notice The chain's wrapped native token (WETH9 on Ethereum), or address(0). Every escrow reads
    /// it at construction: a bridge that refunds a native deposit in its wrapped form (Across pays an
    /// unfilled deposit back to the depositor in the input token, WETH) pays an ETH order's escrow in
    /// WETH, which the escrow unwraps before it re-shields. Immutable: another token, another factory.
    address public immutable WRAPPED_NATIVE;

    constructor(address wrappedNative) {
        WRAPPED_NATIVE = wrappedNative;
    }

    function initCodeHash(T.OrderParams calldata p) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(type(SwapOrderEscrow).creationCode, abi.encode(p)));
    }

    function predict(T.OrderParams calldata p) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), p.orderId, initCodeHash(p))))));
    }

    /// @notice Deploy the escrow for `p` (idempotent: returns the existing one if already deployed).
    function deploy(T.OrderParams calldata p) public returns (SwapOrderEscrow escrow) {
        address predicted = predict(p);
        if (predicted.code.length != 0) return SwapOrderEscrow(payable(predicted));
        escrow = new SwapOrderEscrow{salt: p.orderId}(p);
        assert(address(escrow) == predicted);
        emit OrderEscrowDeployed(p.orderId, address(escrow));
    }

    /// @notice Deploy if needed and execute a signed execution; the caller (relayer) receives the tip.
    function deployAndExecute(T.OrderParams calldata p, T.Execution calldata x) external {
        deploy(p).execute(x, msg.sender);
    }

    /// @notice Deploy if needed and refund to the pool; the caller receives the committed tip.
    function deployAndRefund(T.OrderParams calldata p, bytes calldata noteData) external {
        deploy(p).refund(noteData, msg.sender);
    }
}
