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
import {WETH9Mock} from "../mocks/WETH9Mock.sol";
import {NoReturnToken} from "../mocks/NoReturnToken.sol";

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
    WETH9Mock internal weth;

    uint256 internal constant AMOUNT = 0.5 ether;
    uint256 internal constant TIP = 0.002 ether; // 0.4% < 1%
    bytes internal constant MEMO = "=:BTC.BTC:bc1qfreshdestination:12345678"; // THORChain memo with limit (minOut)

    function setUp() public {
        _deployCore();
        _depositNative(alice, 1 ether, 1);
        weth = new WETH9Mock();
        swapFactory = new SwapOrderFactory(address(weth));
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

    /// Across refunds an unfilled native deposit to its depositor in the input token — WETH
    /// (SpokePool._distributeRelayerRefunds). Without unwrapping, that refund would sit in an ETH order's
    /// escrow for good: refund() re-shields ETH and nothing else can move the WETH.
    function test_ProviderRefundsWrappedNative_UnwrappedAndReShielded() public {
        T.OrderParams memory p = _ethParams();
        address escrow = _fund(p, address(nativeVault), 11, 12);
        provider.setWrappedNative(address(weth));
        provider.setMode(MockSwapProvider.Mode.RefundWrappedToSender);
        swapFactory.deployAndExecute(p, _ethExecution(escrow, address(provider)));
        assertEq(escrow.balance, 0, "the refund came back wrapped");
        assertEq(weth.balanceOf(escrow), AMOUNT - TIP);
        assertEq(SwapOrderEscrow(payable(escrow)).WRAPPED_NATIVE(), address(weth), "read from the factory");
        vm.warp(block.timestamp + 3 hours);
        swapFactory.deployAndRefund(p, _noteData(778));
        assertEq(weth.balanceOf(escrow), 0, "unwrapped");
        assertEq(escrow.balance, 0);
        assertEq(nativeVault.accountedDeposits(), 1 ether - TIP, "the whole order is back in the pool");
    }

    /// A wrapped token that misbehaves cannot hold the ETH refund hostage; its balance is unwrapped by a
    /// later refund() once it works again.
    function test_BrokenWrappedNative_StillReShieldsTheEth_ThenTheRest() public {
        T.OrderParams memory p = _ethParams();
        address escrow = _fund(p, address(nativeVault), 11, 12);
        provider.setMode(MockSwapProvider.Mode.RefundToSender);
        swapFactory.deployAndExecute(p, _ethExecution(escrow, address(provider)));
        vm.deal(address(this), 1 ether);
        weth.deposit{value: 0.01 ether}();
        weth.transfer(escrow, 0.01 ether);
        weth.setBroken(true);
        vm.warp(block.timestamp + 3 hours);
        swapFactory.deployAndRefund(p, _noteData(778));
        assertEq(escrow.balance, 0, "the ETH re-shielded");
        assertEq(weth.balanceOf(escrow), 0.01 ether, "the wrapped part waits");
        weth.setBroken(false);
        swapFactory.deployAndRefund(p, _noteData(778));
        assertEq(weth.balanceOf(escrow), 0);
        assertEq(nativeVault.accountedDeposits(), 1 ether - TIP + 0.01 ether);
    }

    /// A chain without a wrapped native token (factory configured with address(0)): refunds work as before.
    function test_NoWrappedNative_RefundUnchanged() public {
        swapFactory = new SwapOrderFactory(address(0));
        T.OrderParams memory p = _ethParams();
        address escrow = _fund(p, address(nativeVault), 11, 12);
        vm.warp(block.timestamp + 3 hours);
        swapFactory.deployAndRefund(p, _noteData(778));
        assertEq(escrow.balance, 0);
        assertEq(SwapOrderEscrow(payable(escrow)).WRAPPED_NATIVE(), address(0));
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

    /// Review round 3 (C3): an escrow holding exactly the tip (a partial provider refund, dust) paid the tip and then
    /// reverted with nothing left to re-shield — stuck until someone donated a wei. The tip is paid only when something
    /// remains for the user's note; a balance of the tip or less re-shields whole, untipped.
    function test_Refund_ExactlyTheTip_ReShieldsWholeWithoutTip() public {
        T.OrderParams memory p = _ethParams();
        address escrow = swapFactory.predict(p);
        vm.deal(escrow, TIP); // a partial refund of exactly the tip; the order was never funded in full
        uint256 before = nativeVault.accountedDeposits();
        vm.warp(block.timestamp + 3 hours);
        vm.prank(relayer);
        swapFactory.deployAndRefund(p, _noteData(778));
        assertEq(relayer.balance, 0, "no tip: it would have left nothing to re-shield");
        assertEq(escrow.balance, 0, "the escrow emptied");
        assertEq(nativeVault.accountedDeposits() - before, TIP, "the whole balance is the user's note");
        assertFalse(swapFactory.deploy(p).tipPaid(), "the tip stays payable by a later refund that leaves something");
        // a later arrival above the tip pays it, once
        vm.deal(escrow, TIP + 1);
        vm.prank(relayer);
        swapFactory.deployAndRefund(p, _noteData(778));
        assertEq(relayer.balance, TIP);
        assertEq(nativeVault.accountedDeposits() - before, TIP + 1);
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
    /// escrowCall builds (packages/swap-engine/src/engine.ts). The escrow's approval of the token
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

    /// A USDT-like asset (approve / transfer return nothing; the core's vault supports it, spec §8.2):
    /// an order in it must still execute, tip and refund (PP-S10). Typed IERC20 calls expecting a bool
    /// revert on the empty return, which stranded such an order in its escrow.
    function _noReturnOrder() internal returns (NoReturnToken tok, ERC20AssetVault v, T.OrderParams memory p, address escrow) {
        tok = new NoReturnToken();
        v = ERC20AssetVault(factory.getOrCreateERC20Vault(address(tok)));
        tok.mint(alice, 100e6);
        vm.prank(alice);
        tok.approve(address(v), type(uint256).max);
        _depositERC20(v, alice, 10e6, 5);
        p = _params(T.ASSET_ERC20, address(tok), address(v), 4e6, 1e4);
        escrow = _fund(p, address(v), 51, 52);
        assertEq(tok.balanceOf(escrow), 4e6, "tokens released to the predicted escrow");
    }

    function test_NoReturnTokenOrder_ExecutesAndTips() public {
        (NoReturnToken tok,, T.OrderParams memory p, address escrow) = _noReturnOrder();
        address deposit = address(0xDE9052);
        bytes memory transferCall = abi.encodeWithSignature("transfer(address,uint256)", deposit, p.amount - p.executorTip);
        T.Execution memory x = _sign(escrow, p.orderId, ORDER_KEY, address(tok), 0, transferCall, uint64(block.timestamp + 20 minutes));
        vm.prank(relayer);
        swapFactory.deployAndExecute(p, x);
        assertEq(tok.balanceOf(deposit), p.amount - p.executorTip, "the deposit address received the tokens");
        assertEq(tok.balanceOf(relayer), p.executorTip, "the executor tip");
    }

    function test_NoReturnTokenOrder_RefundReShields() public {
        (NoReturnToken tok, ERC20AssetVault v, T.OrderParams memory p, address escrow) = _noReturnOrder();
        vm.warp(block.timestamp + 3 hours);
        vm.prank(relayer);
        swapFactory.deployAndRefund(p, _noteData(778));
        assertEq(tok.balanceOf(escrow), 0, "nothing left in the escrow");
        assertEq(tok.balanceOf(relayer), p.executorTip, "the executor tip");
        assertEq(v.accountedDeposits(), 6e6 + p.amount - p.executorTip, "re-shielded into the token's vault");
        assertTrue(v.isSolvent());
    }

    // ---- a provider pays back in another token (routes that swap first, then bridge) ----

    /// An ETH order whose route swapped ETH into a token and bridged it: the bridge refunds the unfilled
    /// deposit to the escrow in that token. refundToken re-shields it into the token's canonical vault,
    /// created on demand in the same pool as the committed refund vault.
    function _paidBackIn(address token, uint256 amount, uint256 n0, uint256 n1) internal returns (T.OrderParams memory p, SwapOrderEscrow e) {
        provider.setSwappedRefund(token, amount);
        provider.setMode(MockSwapProvider.Mode.RefundTokenToSender);
        p = _ethParams();
        p.orderId = keccak256(abi.encode("paid back in", token));
        address escrow = _fund(p, address(nativeVault), n0, n1);
        T.Execution memory x = _sign(escrow, p.orderId, ORDER_KEY, address(provider), AMOUNT - TIP, _calldata(address(0), AMOUNT - TIP, string(MEMO)), uint64(block.timestamp + 20 minutes));
        vm.prank(relayer);
        swapFactory.deployAndExecute(p, x);
        e = SwapOrderEscrow(payable(escrow));
    }

    function test_ForeignTokenRefund_ReShieldsIntoItsCanonicalVault() public {
        ERC20Mock usdc = new ERC20Mock();
        usdc.mint(address(provider), 2_500e6);
        (, SwapOrderEscrow e) = _paidBackIn(address(usdc), 2_500e6, 61, 62);
        assertEq(usdc.balanceOf(address(e)), 2_500e6, "the bridge refunded the swapped token to the escrow");
        assertEq(address(e).balance, 0, "no ETH left: refund() has nothing to re-shield");
        assertEq(factory.vaultOf(address(usdc)), address(0), "no vault for that token yet");
        vm.warp(block.timestamp + 3 hours);
        uint256 leaves = core.nextLeafIndex();
        vm.prank(relayer);
        e.refundToken(address(usdc), _noteData(778));
        address v = factory.vaultOf(address(usdc));
        assertTrue(v != address(0) && factory.isCanonical(v), "the token's canonical vault, created on demand");
        assertEq(ERC20AssetVault(v).accountedDeposits(), 2_500e6, "re-shielded in full");
        assertEq(usdc.balanceOf(address(e)), 0, "nothing left in the escrow");
        assertEq(core.nextLeafIndex(), leaves + 4, "one deposit group: the pre-committed note in that vault");
        assertTrue(ERC20AssetVault(v).isSolvent());
    }

    function test_ForeignTokenRefund_USDTLike() public {
        NoReturnToken usdt = new NoReturnToken();
        usdt.mint(address(provider), 2_500e6);
        (, SwapOrderEscrow e) = _paidBackIn(address(usdt), 2_500e6, 65, 66);
        vm.warp(block.timestamp + 3 hours);
        e.refundToken(address(usdt), _noteData(778));
        assertEq(ERC20AssetVault(factory.vaultOf(address(usdt))).accountedDeposits(), 2_500e6, "a token returning nothing re-shields too");
        assertEq(usdt.balanceOf(address(e)), 0);
    }

    function test_RefundToken_Guards() public {
        ERC20Mock usdc = new ERC20Mock();
        T.OrderParams memory p = _ethParams();
        address escrow = _fund(p, address(nativeVault), 63, 64);
        SwapOrderEscrow e = swapFactory.deploy(p);
        usdc.mint(escrow, 1e6);
        vm.expectRevert(T.TooEarlyToRefund.selector);
        e.refundToken(address(usdc), _noteData(778));
        vm.warp(block.timestamp + 3 hours);
        vm.expectRevert(T.NoteDataMismatch.selector);
        e.refundToken(address(usdc), _noteData(779));
        vm.expectRevert(T.NotAForeignToken.selector); // an ETH order's ETH re-shields through refund()
        e.refundToken(address(0), _noteData(778));
        vm.expectRevert(T.NotAForeignToken.selector); // an ETH order's WETH unwraps through refund()
        e.refundToken(address(weth), _noteData(778));
        ERC20Mock other = new ERC20Mock();
        vm.expectRevert(T.NothingToRefund.selector);
        e.refundToken(address(other), _noteData(778));
        e.refundToken(address(usdc), _noteData(778));
        assertEq(usdc.balanceOf(escrow), 0, "the foreign token re-shielded");
        assertEq(escrow.balance, AMOUNT, "the order's own ETH is untouched: it goes through refund()");
        swapFactory.deployAndRefund(p, _noteData(778));
        assertEq(escrow.balance, 0);
        // an ERC-20 order's own asset goes through refund() too
        (NoReturnToken tok,, T.OrderParams memory q,) = _noReturnOrder();
        SwapOrderEscrow f = swapFactory.deploy(q);
        vm.warp(q.refundAfter);
        vm.expectRevert(T.NotAForeignToken.selector);
        f.refundToken(address(tok), _noteData(778));
    }

    /// An ERC-20 order whose route swapped the token into WETH and bridged it (the Across swap leg to a
    /// native destination, USDC -> WETH): the unfilled deposit comes back in WETH. refundToken unwraps it
    /// and re-shields it as ETH into the pool's native vault, not as private WETH.
    function _erc20PaidBackIn(address token, uint256 amount) internal returns (ERC20Mock usdc, ERC20AssetVault v, SwapOrderEscrow e) {
        usdc = new ERC20Mock();
        v = ERC20AssetVault(factory.getOrCreateERC20Vault(address(usdc)));
        usdc.mint(alice, 10_000e6);
        vm.prank(alice);
        usdc.approve(address(v), type(uint256).max);
        _depositERC20(v, alice, 5_000e6, 5);
        T.OrderParams memory p = _params(T.ASSET_ERC20, address(usdc), address(v), 2_000e6, 2e6);
        p.orderId = keccak256(abi.encode("erc20 paid back in", token));
        address escrow = _fund(p, address(v), 71, 72);
        provider.setSwappedRefund(token == address(0) ? address(usdc) : token, token == address(0) ? 0 : amount);
        provider.setMode(MockSwapProvider.Mode.RefundTokenToSender);
        T.Execution memory x = _sign(escrow, p.orderId, ORDER_KEY, address(provider), 0, _calldata(address(usdc), 2_000e6 - 2e6, string(MEMO)), uint64(block.timestamp + 20 minutes));
        vm.prank(relayer);
        swapFactory.deployAndExecute(p, x);
        e = SwapOrderEscrow(payable(escrow));
        assertEq(usdc.balanceOf(escrow), 0, "the provider pulled the order");
    }

    function test_ERC20Order_PaidBackInWrappedNative_ReShieldsAsEth() public {
        vm.deal(address(this), 1 ether);
        weth.deposit{value: 0.6 ether}();
        weth.transfer(address(provider), 0.6 ether);
        (, ERC20AssetVault v, SwapOrderEscrow e) = _erc20PaidBackIn(address(weth), 0.6 ether);
        assertEq(weth.balanceOf(address(e)), 0.6 ether, "the bridge refunded the swapped WETH to the escrow");
        uint256 pooled = nativeVault.accountedDeposits();
        uint256 leaves = core.nextLeafIndex();
        vm.warp(block.timestamp + 3 hours);
        vm.prank(relayer);
        e.refundToken(address(weth), _noteData(778));
        assertEq(weth.balanceOf(address(e)), 0, "unwrapped");
        assertEq(address(e).balance, 0, "nothing left in the escrow");
        assertEq(nativeVault.accountedDeposits(), pooled + 0.6 ether, "re-shielded as ETH into the native vault");
        assertEq(factory.vaultOf(address(weth)), address(0), "no private WETH: no WETH vault was needed");
        assertEq(core.nextLeafIndex(), leaves + 4, "one deposit group: the pre-committed note");
        assertEq(v.accountedDeposits(), 3_000e6, "the token vault released exactly the order");
        assertTrue(nativeVault.isSolvent());
    }

    /// ETH that lands at an ERC-20 order's escrow (a provider refunding natively, or anyone sending it)
    /// re-shields as ETH too; refund() only moves the order's token, so nothing else could move it.
    function test_ERC20Order_EthAtTheEscrow_ReShieldsAsEth() public {
        (ERC20Mock usdc,, SwapOrderEscrow e) = _erc20PaidBackIn(address(0), 0);
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(e).call{value: 0.25 ether}("");
        assertTrue(ok);
        vm.warp(block.timestamp + 3 hours);
        T.OrderParams memory p = _paramsOf(e);
        vm.expectRevert(T.NothingToRefund.selector);
        swapFactory.deployAndRefund(p, _noteData(778)); // the order's own token: nothing left
        uint256 pooled = nativeVault.accountedDeposits();
        e.refundToken(address(0), _noteData(778));
        assertEq(address(e).balance, 0);
        assertEq(nativeVault.accountedDeposits(), pooled + 0.25 ether);
        vm.expectRevert(T.NothingToRefund.selector);
        e.refundToken(address(0), _noteData(778));
        vm.expectRevert(T.NotAForeignToken.selector);
        e.refundToken(address(usdc), _noteData(778));
    }

    /// A wrapped token that fails to unwrap blocks only its own refund; ETH at the escrow still re-shields.
    function test_ERC20Order_BrokenWrappedNative_EthStillReShields() public {
        vm.deal(address(this), 1 ether);
        weth.deposit{value: 0.3 ether}();
        weth.transfer(address(provider), 0.3 ether);
        (, , SwapOrderEscrow e) = _erc20PaidBackIn(address(weth), 0.3 ether);
        (bool ok,) = address(e).call{value: 0.1 ether}("");
        assertTrue(ok);
        weth.setBroken(true);
        vm.warp(block.timestamp + 3 hours);
        vm.expectRevert();
        e.refundToken(address(weth), _noteData(778));
        uint256 pooled = nativeVault.accountedDeposits();
        e.refundToken(address(0), _noteData(778));
        assertEq(nativeVault.accountedDeposits(), pooled + 0.1 ether, "the ETH re-shielded");
        assertEq(weth.balanceOf(address(e)), 0.3 ether, "the wrapped part waits");
        weth.setBroken(false);
        e.refundToken(address(weth), _noteData(778));
        assertEq(nativeVault.accountedDeposits(), pooled + 0.4 ether, "then the rest, as ETH");
        assertEq(weth.balanceOf(address(e)), 0);
    }

    function _paramsOf(SwapOrderEscrow e) internal view returns (T.OrderParams memory p) {
        p.orderId = e.ORDER_ID();
        p.assetType = e.ASSET_TYPE();
        p.asset = e.ASSET();
        p.amount = e.AMOUNT();
        p.orderSigner = e.ORDER_SIGNER();
        p.executeDeadline = e.EXECUTE_DEADLINE();
        p.refundAfter = e.REFUND_AFTER();
        p.refundVault = e.REFUND_VAULT();
        p.refundOwnerCommitment = e.REFUND_OWNER_COMMITMENT();
        p.refundNoteSecret = e.REFUND_NOTE_SECRET();
        p.refundNoteDataHash = e.REFUND_NOTE_DATA_HASH();
        p.executorTip = e.EXECUTOR_TIP();
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
    /// (packages/swap-engine/test/endpoints.test.ts).
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
