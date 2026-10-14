// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ShieldReceiverTypes as T} from "./ShieldReceiverTypes.sol";
import {ShieldReceiver} from "./ShieldReceiver.sol";

/// @title ShieldReceiverFactory — counterfactual CREATE2 deployer for ShieldReceiver (Privacy Wallet Web spec v2.0 §11.2)
/// @notice Permissionless, ownerless, stateless. The receiver's address is a pure function of its parameters, so the
/// wallet computes it off-chain, names it as a same-chain swap's destination, and any relayer deploys it and shields the
/// delivery later. The pool's vault factory and the chain's wrapped native token are immutable: another pool, another
/// factory.
contract ShieldReceiverFactory {
    event ShieldReceiverDeployed(bytes32 indexed receiptId, address receiver);

    error ZeroVaultFactory();

    address public immutable VAULT_FACTORY;
    address public immutable WRAPPED_NATIVE;

    constructor(address vaultFactory, address wrappedNative) {
        if (vaultFactory == address(0)) revert ZeroVaultFactory();
        VAULT_FACTORY = vaultFactory;
        WRAPPED_NATIVE = wrappedNative;
    }

    function initCodeHash(T.ReceiverParams calldata p) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(type(ShieldReceiver).creationCode, abi.encode(p)));
    }

    function predict(T.ReceiverParams calldata p) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), p.receiptId, initCodeHash(p))))));
    }

    /// @notice Deploy the receiver for `p` (idempotent: returns the existing one if already deployed).
    function deploy(T.ReceiverParams calldata p) public returns (ShieldReceiver receiver) {
        address predicted = predict(p);
        if (predicted.code.length != 0) return ShieldReceiver(payable(predicted));
        receiver = new ShieldReceiver{salt: p.receiptId}(p);
        assert(address(receiver) == predicted);
        emit ShieldReceiverDeployed(p.receiptId, address(receiver));
    }

    /// @notice Deploy if needed and shield the delivery; the caller (the relayer) receives the committed tip.
    function deployAndShield(T.ReceiverParams calldata p, bytes calldata noteData) external returns (uint32) {
        return deploy(p).shield(noteData, msg.sender);
    }

    /// @notice Deploy if needed and shield another token that arrived into its own canonical vault.
    function deployAndShieldToken(T.ReceiverParams calldata p, address token, bytes calldata noteData) external returns (uint32) {
        return deploy(p).shieldToken(token, noteData);
    }
}
