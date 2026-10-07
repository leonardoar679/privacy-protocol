// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PPTestBase} from "../PPTestBase.sol";
import {CoreTypes} from "../../src/core/CoreTypes.sol";
import {ERC20AssetVault} from "../../src/vault/ERC20AssetVault.sol";
import {IAssetVault} from "../../src/vault/IAssetVault.sol";
import {SwapOrderTypes as T} from "../../src/periphery/swap/SwapOrderTypes.sol";
import {SwapOrderEscrow} from "../../src/periphery/swap/SwapOrderEscrow.sol";
import {SwapOrderFactory} from "../../src/periphery/swap/SwapOrderFactory.sol";
import {MockSwapProvider} from "../mocks/MockSwapProvider.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";

/// The private-swap exit interface (private-swap spec §6, §7, §11): a private withdrawal funds a
/// counterfactual escrow; a relayer submits an execution signed by the order's one-time key; failures
/// re-shield into the pool as a pre-committed fresh note. PrivacyCore is untouched throughout (it is
/// only ever a normal withdrawal recipient). Mock verifier/hasher; the provider is a mock router.
contract SwapOrderEscrowTest is PPTestBase {
    address internal alice = address(0xA11CE);
    address internal relayer = address(0x5E1A);
    uint256 internal constant ORDER_KEY = 0xA11CE0; // the wallet's one-time order key
    address internal orderSigner;
    SwapOrderFactory internal swapFactory;
    MockSwapProvider internal provider;
    MockSwapProvider internal fallbackProvider;

    uint256 internal constant AMOUNT = 0.5 ether;
    uint256 internal constant TIP = 0.002 ether; // 0.4% < 1%
    bytes internal constant MEMO = "=:BTC.BTC:bc1qfreshdestination:12345678"; // THORChain memo with limit (minOut)

    function setUp() public {
        _deployCore();
        _depositNative(alice, 1 ether, 1);
        swapFactory = new SwapOrderFactory();
        provider = new MockSwapProvider();
        fallbackProvider = new MockSwapProvider();
        orderSigner = vm.addr(ORDER_KEY);
    }

    /// the test contract acts as the relayer in the un-pranked calls, so it must take the tip
    receive() external payable {}

    // ---- order helpers ----
    function _params(uint8 assetType, address asset, address refundVault, uint256 amount, uint256 tip)
        internal
        view
        returns (T.OrderParams memory p)
    {
        p.orderId = keccak256(abi.encode("order", assetType, asset));
        p.assetType = assetType;
        p.asset = asset;
        p.amount = amount;
        p.orderSigner = orderSigner;
        p.executeDeadline = uint64(block.timestamp + 30 minutes); // latest; the quote expiry is <= this
        p.refundAfter = uint64(block.timestamp + 2 hours);
        p.refundVault = refundVault;
        p.refundOwnerCommitment = 777; // the fresh note the wallet pre-generated
        p.refundNoteSecret = 778;
        p.refundNoteDataHash = keccak256(_noteData(778));
        p.executorTip = tip;
    }

    function _ethParams() internal view returns (T.OrderParams memory) {
        return _params(T.ASSET_ETH, address(0), address(nativeVault), AMOUNT, TIP);
    }

    function _calldata(address asset, uint256 amount, string memory memo) internal view returns (bytes memory) {
        return abi.encodeWithSelector(MockSwapProvider.depositWithExpiry.selector, address(0xB0B), asset, amount, memo, block.timestamp + 1 hours);
    }

    /// The wallet signs the execution with the one-time order key (off-chain in production), over the
    /// digest the escrow will compute — before the escrow exists, so the formula is replicated here
    /// (test_ExecutionDigest_MatchesContract checks it against the deployed contract).
    function _digest(address escrow, bytes32 orderId, address prov, uint256 value, bytes memory cd, uint64 deadline) internal view returns (bytes32) {
        return keccak256(abi.encode(T.EXECUTE_TAG, block.chainid, escrow, orderId, prov, value, keccak256(cd), deadline));
    }

    function _sign(address escrow, bytes32 orderId, uint256 key, address prov, uint256 value, bytes memory cd, uint64 deadline)
        internal
        view
        returns (T.Execution memory x)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(escrow, orderId, prov, value, cd, deadline));
        x = T.Execution({provider: prov, value: value, providerCalldata: cd, deadline: deadline, signature: abi.encodePacked(r, s, v)});
    }

    function _ethExecution(address escrow, address prov) internal view returns (T.Execution memory) {
        return _sign(escrow, _ethParams().orderId, ORDER_KEY, prov, AMOUNT - TIP, _calldata(address(0), AMOUNT - TIP, string(MEMO)), uint64(block.timestamp + 20 minutes));
    }

    function test_ExecutionDigest_MatchesContract() public {
        T.OrderParams memory p = _ethParams();
        SwapOrderEscrow e = swapFactory.deploy(p);
        bytes memory cd = _calldata(address(0), 1, "memo");
        assertEq(e.executionDigest(address(provider), 1, keccak256(cd), 5), _digest(address(e), p.orderId, address(provider), 1, cd, 5), "off-chain digest == on-chain digest");
    }

    /// Alice's private withdrawal to the (not yet deployed) escrow address.
    function _fund(T.OrderParams memory p, address vault, uint256 n0, uint256 n1) internal returns (address escrow) {
        escrow = swapFactory.predict(p);
        CoreTypes.PublicInputs memory pi = _withdrawPI(vault, escrow, p.amount, n0, n1);
        _transact(pi);
    }

    // ---- happy path ----
    function test_PrivateWithdrawal_FundsCounterfactualEscrow_RelayerExecutes() public {
        T.OrderParams memory p = _ethParams();
        address escrow = _fund(p, address(nativeVault), 11, 12);
        assertEq(escrow.balance, AMOUNT, "withdrawal landed at the predicted address before deployment");
        assertEq(escrow.code.length, 0, "not deployed yet");
        assertEq(address(core).balance, 0);

        T.Execution memory x = _ethExecution(escrow, address(provider));
        vm.prank(relayer);
        swapFactory.deployAndExecute(p, x);

        assertEq(provider.receivedEth(), AMOUNT - TIP, "provider got the order value");
        assertEq(provider.lastMemo(), string(MEMO), "memo (destination + limit) is exactly the signed one");
        assertEq(relayer.balance, TIP, "relayer paid the committed tip");
        assertEq(escrow.balance, 0);
        assertTrue(SwapOrderEscrow(payable(escrow)).executed());
        assertEq(address(core).balance, 0, "core never touched");
        assertEq(nativeVault.accountedDeposits(), 1 ether - AMOUNT, "vault accounting == the one withdrawal");
    }

    function test_Predict_MatchesDeployedAddress() public {
        T.OrderParams memory p = _ethParams();
        address predicted = swapFactory.predict(p);
        SwapOrderEscrow e = swapFactory.deploy(p);
        assertEq(address(e), predicted);
        assertEq(address(swapFactory.deploy(p)), predicted, "idempotent");
        assertEq(e.ORDER_ID(), p.orderId);
        assertEq(e.ORDER_SIGNER(), orderSigner);
    }

    /// Plan §57: the provider halts after funding; the wallet signs a new execution for a fallback
    /// provider. Nothing on-chain changes except who finally receives the funds.
    function test_FundedOrder_CanBeReRoutedToFallbackProvider() public {
        T.OrderParams memory p = _ethParams();
        address escrow = _fund(p, address(nativeVault), 11, 12);
        provider.setMode(MockSwapProvider.Mode.Revert); // THORChain halted
        vm.expectRevert(T.ProviderCallFailed.selector);
        swapFactory.deployAndExecute(p, _ethExecution(escrow, address(provider)));

        swapFactory.deployAndExecute(p, _ethExecution(escrow, address(fallbackProvider)));
        assertEq(fallbackProvider.receivedEth(), AMOUNT - TIP, "fallback provider executed the same order");
        assertEq(provider.receivedEth(), 0);
    }

    // ---- refund to pool ----
    function test_QuoteExpires_RefundReShieldsAsFreshNote_ThenSpendable() public {
        T.OrderParams memory p = _ethParams();
        address escrow = _fund(p, address(nativeVault), 11, 12);
        uint256 vaultBefore = address(nativeVault).balance;
        uint256 accountedBefore = nativeVault.accountedDeposits();
        uint32 leafBefore = core.nextLeafIndex();
        T.Execution memory x = _ethExecution(escrow, address(provider));

        vm.warp(block.timestamp + 31 minutes);
        vm.expectRevert(T.DeadlinePassed.selector);
        swapFactory.deployAndExecute(p, x);
        vm.expectRevert(T.TooEarlyToRefund.selector);
        swapFactory.deployAndRefund(p, _noteData(778));

        vm.warp(block.timestamp + 2 hours);
        vm.prank(relayer);
        swapFactory.deployAndRefund(p, _noteData(778));

        assertEq(escrow.balance, 0, "escrow emptied");
        assertEq(relayer.balance, TIP);
        assertEq(address(nativeVault).balance, vaultBefore + AMOUNT - TIP, "funds are back in the vault");
        assertEq(nativeVault.accountedDeposits(), accountedBefore + AMOUNT - TIP, "as a shielded liability");
        assertEq(core.nextLeafIndex(), leafBefore + 4, "a new note was inserted (one aligned group)");

        // the refunded note is ordinary private money again: spend it to Bob
        CoreTypes.PublicInputs memory pi = _withdrawPI(address(nativeVault), address(0xB0B), AMOUNT - TIP, 21, 22);
        _transact(pi);
        assertEq(address(0xB0B).balance, AMOUNT - TIP);
    }

    function test_ProviderRevert_FundsStayAndRefundLater() public {
        T.OrderParams memory p = _ethParams();
        address escrow = _fund(p, address(nativeVault), 11, 12);
        SwapOrderEscrow e = swapFactory.deploy(p);
        provider.setMode(MockSwapProvider.Mode.Revert);
        vm.expectRevert(T.ProviderCallFailed.selector);
        e.execute(_ethExecution(escrow, address(provider)), relayer);
        assertEq(escrow.balance, AMOUNT, "nothing left the escrow");
        assertFalse(e.executed());

        vm.warp(block.timestamp + 3 hours);
        swapFactory.deployAndRefund(p, _noteData(778));
        assertEq(nativeVault.accountedDeposits(), 1 ether - AMOUNT + AMOUNT - TIP);
    }

    /// Provider refunds reach the escrow with a gas stipend: THORChain's router refunds ETH with `send`
    /// (2300 gas) and Chainflip's Vault forwards 8,000 gas (`_GAS_TO_FORWARD`, verified source). Both
    /// silently keep the ETH when the call fails, so the escrow's receive() must stay this cheap or a
    /// provider refund would never reach refund().
    function test_ProviderRefund_FitsTheGasStipendsProvidersForward() public {
        SwapOrderEscrow e = swapFactory.deploy(_ethParams());
        vm.deal(address(this), 1 ether);
        assertTrue(payable(address(e)).send(0.1 ether), "THORChain router: send with the 2300-gas stipend");
        (bool ok,) = address(e).call{gas: 8_000, value: 0.1 ether}("");
        assertTrue(ok, "Chainflip Vault: call with 8,000 gas");
        assertEq(address(e).balance, 0.2 ether);
    }

    function test_ProviderRefundsToEscrow_ThenReShield() public {
        T.OrderParams memory p = _ethParams();
        address escrow = _fund(p, address(nativeVault), 11, 12);
        provider.setMode(MockSwapProvider.Mode.RefundToSender); // e.g. a THORChain refund
        swapFactory.deployAndExecute(p, _ethExecution(escrow, address(provider)));
        assertEq(escrow.balance, AMOUNT - TIP, "provider refunded the escrow");
        vm.warp(block.timestamp + 3 hours);
        swapFactory.deployAndRefund(p, _noteData(778)); // tip already paid once, whole balance re-shielded
        assertEq(escrow.balance, 0);
        assertEq(nativeVault.accountedDeposits(), 1 ether - TIP);
    }

    // ---- authorization binding ----
    function test_ExecutionNotSignedByOrderKey_Rejected() public {
        T.OrderParams memory p = _ethParams();
        address escrow = _fund(p, address(nativeVault), 11, 12);
        T.Execution memory x = _sign(escrow, p.orderId, 0xBAD, address(provider), AMOUNT - TIP, _calldata(address(0), AMOUNT - TIP, string(MEMO)), uint64(block.timestamp + 20 minutes));
        vm.expectRevert(T.BadSignature.selector);
        swapFactory.deployAndExecute(p, x);
    }

    function test_TamperedCalldata_Rejected() public {
        T.OrderParams memory p = _ethParams();
        address escrow = _fund(p, address(nativeVault), 11, 12);
        T.Execution memory x = _ethExecution(escrow, address(provider));
        x.providerCalldata = _calldata(address(0), AMOUNT - TIP, "=:BTC.BTC:bc1qattacker:1"); // relayer lowers the limit / changes dest
        vm.expectRevert(T.BadSignature.selector);
        swapFactory.deployAndExecute(p, x);
        x = _ethExecution(escrow, address(provider));
        x.provider = address(fallbackProvider); // or redirects to another provider
        vm.expectRevert(T.BadSignature.selector);
        swapFactory.deployAndExecute(p, x);
        x = _ethExecution(escrow, address(provider));
        x.value = AMOUNT - TIP - 1; // or changes the value
        vm.expectRevert(T.BadSignature.selector);
        swapFactory.deployAndExecute(p, x);
    }

    function test_SignedDeadline_CannotExceedCommittedDeadline() public {
        T.OrderParams memory p = _ethParams();
        address escrow = _fund(p, address(nativeVault), 11, 12);
        T.Execution memory x = _sign(escrow, p.orderId, ORDER_KEY, address(provider), AMOUNT - TIP, _calldata(address(0), AMOUNT - TIP, string(MEMO)), uint64(block.timestamp + 3 hours));
        vm.expectRevert(T.DeadlineTooLate.selector);
        swapFactory.deployAndExecute(p, x);
    }

    function test_ReplayOnAnotherEscrow_Rejected() public {
        T.OrderParams memory p1 = _ethParams();
        T.OrderParams memory p2 = _ethParams();
        p2.orderId = keccak256("order-2");
        address e1 = _fund(p1, address(nativeVault), 11, 12);
        address e2 = _fund(p2, address(nativeVault), 21, 22);
        T.Execution memory x = _ethExecution(e1, address(provider)); // signed for escrow 1 (orderId 1)
        swapFactory.deploy(p2);
        vm.expectRevert(T.BadSignature.selector);
        SwapOrderEscrow(payable(e2)).execute(x, relayer); // cannot drive escrow 2
    }

    function test_TamperedRefundPayload_Rejected() public {
        T.OrderParams memory p = _ethParams();
        _fund(p, address(nativeVault), 11, 12);
        vm.warp(block.timestamp + 3 hours);
        vm.expectRevert(T.NoteDataMismatch.selector);
        swapFactory.deployAndRefund(p, _noteData(999));
    }

    function test_ExecuteTwice_Rejected() public {
        T.OrderParams memory p = _ethParams();
        address escrow = _fund(p, address(nativeVault), 11, 12);
        T.Execution memory x = _ethExecution(escrow, address(provider));
        swapFactory.deployAndExecute(p, x);
        SwapOrderEscrow e = SwapOrderEscrow(payable(escrow));
        vm.expectRevert(T.AlreadyExecuted.selector);
        e.execute(x, relayer);
    }

    function test_UnfundedEscrow_CannotExecute() public {
        T.OrderParams memory p = _ethParams();
        address escrow = swapFactory.predict(p);
        vm.expectRevert(T.NotFunded.selector);
        swapFactory.deployAndExecute(p, _ethExecution(escrow, address(provider)));
    }

    function test_BadParams_Rejected() public {
        T.OrderParams memory p = _ethParams();
        p.executorTip = AMOUNT / 50; // 2%
        vm.expectRevert(T.TipTooLarge.selector);
        swapFactory.deploy(p);
        p = _ethParams();
        p.refundAfter = p.executeDeadline - 1;
        vm.expectRevert(T.BadDeadlines.selector);
        swapFactory.deploy(p);
        p = _ethParams();
        p.orderSigner = address(0);
        vm.expectRevert(T.ZeroSigner.selector);
        swapFactory.deploy(p);
    }

    // ---- ERC-20 order ----
    function test_ERC20Order_ExecuteAndRefund() public {
        ERC20Mock tok = new ERC20Mock();
        ERC20AssetVault v = ERC20AssetVault(factory.getOrCreateERC20Vault(address(tok)));
        tok.mint(alice, 100e18);
        vm.prank(alice);
        tok.approve(address(v), type(uint256).max);
        _depositERC20(v, alice, 10e18, 5);

        uint256 amount = 4e18;
        uint256 tip = 1e16;
        T.OrderParams memory p = _params(T.ASSET_ERC20, address(tok), address(v), amount, tip);
        address escrow = _fund(p, address(v), 31, 32);
        assertEq(tok.balanceOf(escrow), amount, "tokens released to the predicted escrow");

        T.Execution memory x = _sign(escrow, p.orderId, ORDER_KEY, address(provider), 0, _calldata(address(tok), amount - tip, string(MEMO)), uint64(block.timestamp + 20 minutes));
        vm.prank(relayer);
        swapFactory.deployAndExecute(p, x);
        assertEq(provider.receivedTokens(), amount - tip, "provider pulled the tokens");
        assertEq(tok.balanceOf(relayer), tip);
        assertEq(tok.balanceOf(address(core)), 0);
        assertEq(v.accountedDeposits(), 6e18);

        // a second, failed order refunds into the ERC-20 vault
        T.OrderParams memory p2 = _params(T.ASSET_ERC20, address(tok), address(v), amount, tip);
        p2.orderId = keccak256("second");
        _fund(p2, address(v), 41, 42);
        vm.warp(block.timestamp + 3 hours);
        swapFactory.deployAndRefund(p2, _noteData(778));
        assertEq(v.accountedDeposits(), 2e18 + amount - tip, "refund re-shielded into the token vault");
        assertTrue(v.isSolvent());
    }

    /// A deposit-address provider for a token (a 1Click / inbound-address style route): the order key
    /// signs a call to the TOKEN itself, transfer(depositAddress, amount - tip) - what the engine's
    /// escrowCall builds (services/private-swap/src/engine.ts). The escrow's approval of the token
    /// contract it calls is harmless; the tokens land at the deposit address and nowhere else.
    function test_ERC20Order_PlainDepositAddress_PaidWithTokenTransfer() public {
        ERC20Mock tok = new ERC20Mock();
        ERC20AssetVault v = ERC20AssetVault(factory.getOrCreateERC20Vault(address(tok)));
        tok.mint(alice, 100e18);
        vm.prank(alice);
        tok.approve(address(v), type(uint256).max);
        _depositERC20(v, alice, 10e18, 5);

        uint256 amount = 4e18;
        uint256 tip = 1e16;
        T.OrderParams memory p = _params(T.ASSET_ERC20, address(tok), address(v), amount, tip);
        address escrow = _fund(p, address(v), 31, 32);
        address deposit = address(0xDE9051);
        bytes memory transferCall = abi.encodeWithSignature("transfer(address,uint256)", deposit, amount - tip);
        T.Execution memory x = _sign(escrow, p.orderId, ORDER_KEY, address(tok), 0, transferCall, uint64(block.timestamp + 20 minutes));
        vm.prank(relayer);
        swapFactory.deployAndExecute(p, x);
        assertEq(tok.balanceOf(deposit), amount - tip, "the deposit address received the tokens");
        assertEq(tok.balanceOf(relayer), tip, "the executor tip");
        assertEq(tok.balanceOf(escrow), 0, "nothing left in the escrow");
        assertEq(v.accountedDeposits(), 6e18, "the vault released exactly the order");
    }

    // ---- provider compromise (plan §74): the damage bound ----
    function test_MaliciousProvider_CanOnlyTakeTheEscrowBalance() public {
        T.OrderParams memory p = _ethParams();
        address escrow = _fund(p, address(nativeVault), 11, 12);
        uint256 vaultBal = address(nativeVault).balance;
        uint256 accounted = nativeVault.accountedDeposits();

        // the provider, once called, tries to make OUR vault release more funds to it
        provider.setMode(MockSwapProvider.Mode.Malicious);
        provider.arm(address(nativeVault), abi.encodeWithSelector(IAssetVault.release.selector, address(provider), 0.4 ether));
        T.Execution memory x = _ethExecution(escrow, address(provider));
        swapFactory.deployAndExecute(p, x);

        assertFalse(provider.maliciousCallOk(), "vault refused the provider (not core)");
        assertEq(provider.receivedEth(), AMOUNT - TIP, "it got exactly the order value, nothing more");
        assertEq(address(nativeVault).balance, vaultBal, "vault balance untouched");
        assertEq(nativeVault.accountedDeposits(), accounted, "vault accounting untouched");
        assertEq(address(core).balance, 0, "core holds nothing to take");
        assertEq(escrow.balance, 0, "maximum loss == the escrow's balance");

        // and it cannot re-enter the escrow for a second payout either
        T.OrderParams memory p2 = _ethParams();
        p2.orderId = keccak256("order-2");
        address escrow2 = _fund(p2, address(nativeVault), 21, 22);
        T.Execution memory x2 = _sign(escrow2, p2.orderId, ORDER_KEY, address(provider), AMOUNT - TIP, _calldata(address(0), AMOUNT - TIP, string(MEMO)), uint64(block.timestamp + 20 minutes));
        provider.arm(escrow2, abi.encodeWithSelector(SwapOrderEscrow.execute.selector, x2, address(provider)));
        swapFactory.deployAndExecute(p2, x2);
        assertFalse(provider.maliciousCallOk(), "re-entry into an executed escrow rejected");
    }

    /// Cross-implementation vector (SWAP_VECTOR=true): the TypeScript engine must predict the same
    /// escrow address and compute the same execution digest for these exact inputs
    /// (services/private-swap/test/endpoints.test.ts).
    function test_EmitEndpointVector() public {
        if (!vm.envOr("SWAP_VECTOR", false)) return;
        T.OrderParams memory p = _ethParams();
        address escrow = swapFactory.predict(p);
        vm.writeFile(
            "test/periphery/vectors/endpoint.json",
            string.concat(_vecHead(p, escrow), _vecParamsA(p), _vecParamsB(p), _vecExec(p, escrow))
        );
    }

    function _vecHead(T.OrderParams memory p, address escrow) internal view returns (string memory) {
        return string.concat(
            '{"chainId":', vm.toString(block.chainid), ',"factory":"', vm.toString(address(swapFactory)),
            '","initCodeHash":"', vm.toString(swapFactory.initCodeHash(p)), '","predicted":"', vm.toString(escrow), '",'
        );
    }

    function _vecParamsA(T.OrderParams memory p) internal pure returns (string memory) {
        return string.concat(
            '"params":{"orderId":"', vm.toString(p.orderId), '","assetType":', vm.toString(uint256(p.assetType)),
            ',"asset":"', vm.toString(p.asset), '","amount":"', vm.toString(p.amount), '","orderSigner":"', vm.toString(p.orderSigner),
            '","executeDeadline":', vm.toString(uint256(p.executeDeadline)), ',"refundAfter":', vm.toString(uint256(p.refundAfter)), ','
        );
    }

    function _vecParamsB(T.OrderParams memory p) internal pure returns (string memory) {
        return string.concat(
            '"refundVault":"', vm.toString(p.refundVault), '","refundOwnerCommitment":"', vm.toString(p.refundOwnerCommitment),
            '","refundNoteSecret":"', vm.toString(p.refundNoteSecret), '","refundNoteDataHash":"', vm.toString(p.refundNoteDataHash),
            '","executorTip":"', vm.toString(p.executorTip), '"},'
        );
    }

    function _vecExec(T.OrderParams memory p, address escrow) internal view returns (string memory) {
        bytes memory cd = _calldata(address(0), AMOUNT - TIP, string(MEMO));
        uint64 deadline = uint64(block.timestamp + 20 minutes);
        bytes32 digest = _digest(escrow, p.orderId, address(provider), AMOUNT - TIP, cd, deadline);
        return string.concat(
            '"execution":{"provider":"', vm.toString(address(provider)), '","value":"', vm.toString(AMOUNT - TIP),
            '","calldataHash":"', vm.toString(keccak256(cd)), '","deadline":', vm.toString(uint256(deadline)),
            ',"digest":"', vm.toString(digest), '"}}'
        );
    }

    /// Everything above happens with PrivacyCore being nothing but a withdrawal recipient's payer.
    function test_CoreIsUnchanged_ByPeriphery() public view {
        assertEq(core.PROTOCOL_ID(), keccak256("privacy-protocol/v1.0"));
        assertEq(address(core).balance, 0);
    }
}
