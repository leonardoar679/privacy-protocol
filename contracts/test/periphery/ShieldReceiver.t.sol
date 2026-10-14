// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PPTestBase} from "../PPTestBase.sol";
import {ERC20AssetVault} from "../../src/vault/ERC20AssetVault.sol";
import {ShieldReceiverFactory} from "../../src/periphery/shield/ShieldReceiverFactory.sol";
import {ShieldReceiver} from "../../src/periphery/shield/ShieldReceiver.sol";
import {ShieldReceiverTypes as T} from "../../src/periphery/shield/ShieldReceiverTypes.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {NoReturnToken} from "../mocks/NoReturnToken.sol";
import {WETH9Mock} from "../mocks/WETH9Mock.sol";

/// THORChain's router pays an EVM destination with `send` — a 2300-gas stipend.
contract SendPayer {
    function pay(address payable to, uint256 amount) external returns (bool) {
        return to.send(amount);
    }

    receive() external payable {}
}

/// A tip recipient that re-enters the receiver from its receive().
contract ReenteringShielder {
    ShieldReceiverFactory internal immutable f;
    bytes internal noteData;
    T.ReceiverParams internal p;
    bool public reentered;

    constructor(ShieldReceiverFactory factory_) {
        f = factory_;
    }

    function arm(T.ReceiverParams calldata params, bytes calldata nd) external {
        p = params;
        noteData = nd;
    }

    receive() external payable {
        reentered = true;
        f.deployAndShield(p, noteData); // must revert: the receiver is mid-shield
    }
}

/// The same-chain swap's one-time destination (Privacy Wallet Web spec v2.0 §11.2): predicted before the swap, paid by
/// the provider (a 2300-gas send before or after deployment), deployed and shielded by anyone into the asset's canonical
/// vault as the committed note — the tip once and only on a delivery at least the minimum, an ETH receipt unwrapping
/// WETH, another token into its own vault, an unsupported one only to the fallback. Production core and vaults.
contract ShieldReceiverTest is PPTestBase {
    ShieldReceiverFactory internal f;
    WETH9Mock internal weth;
    address internal relayer = address(0x5E1A);
    address internal fallbackAddr = address(0xFA11);

    uint256 internal constant OC = 0x0C0C;
    uint256 internal constant SECRET = 0x5EC5EC;
    uint256 internal constant MIN = 1 ether;
    uint256 internal constant TIP = 0.01 ether;

    function setUp() public {
        _deployCore();
        weth = new WETH9Mock();
        f = new ShieldReceiverFactory(address(factory), address(weth));
    }

    function _params(address asset, uint256 min, uint256 tip, bytes memory nd) internal pure returns (T.ReceiverParams memory p) {
        p.receiptId = keccak256(abi.encode("receipt", asset, min));
        p.asset = asset;
        p.minAmount = min;
        p.shieldTip = tip;
        p.ownerCommitment = OC;
        p.noteSecret = SECRET;
        p.noteDataHash = keccak256(nd);
        p.fallbackRecipient = address(0xFA11);
    }

    function _eth() internal view returns (T.ReceiverParams memory p, bytes memory nd) {
        nd = _noteData(7);
        p = _params(address(0), MIN, TIP, nd);
    }

    // ---- the address --------------------------------------------------------------------------------------------------

    function test_PredictEqualsDeployAndDeployIsIdempotent() public {
        (T.ReceiverParams memory p,) = _eth();
        address predicted = f.predict(p);
        ShieldReceiver r = f.deploy(p);
        assertEq(address(r), predicted, "the wallet's predicted address is the receiver");
        assertEq(address(f.deploy(p)), predicted, "a second deploy returns the same receiver");
        assertEq(r.VAULT_FACTORY(), address(factory));
        assertEq(r.WRAPPED_NATIVE(), address(weth));
        assertEq(r.OWNER_COMMITMENT(), OC);
        assertEq(r.FALLBACK_RECIPIENT(), fallbackAddr);
        // another parameter, another address
        p.minAmount += 1;
        assertTrue(f.predict(p) != predicted, "every parameter is committed");
    }

    function test_ConstructorRefusesBadParams() public {
        (T.ReceiverParams memory p,) = _eth();
        p.shieldTip = MIN / 100 + 1;
        vm.expectRevert(T.TipTooLarge.selector);
        f.deploy(p);
        (p,) = _eth();
        p.fallbackRecipient = address(0);
        vm.expectRevert(T.ZeroFallback.selector);
        f.deploy(p);
        (p,) = _eth();
        p.minAmount = 0;
        vm.expectRevert(T.ZeroMinimum.selector);
        f.deploy(p);
        vm.expectRevert(ShieldReceiverFactory.ZeroVaultFactory.selector);
        new ShieldReceiverFactory(address(0), address(weth));
    }

    // ---- delivery: THORChain's 2300-gas send ---------------------------------------------------------------------------

    function test_A2300GasSendArrivesBeforeAndAfterDeployment() public {
        (T.ReceiverParams memory p,) = _eth();
        SendPayer payer = new SendPayer();
        vm.deal(address(payer), 3 ether);
        address payable to = payable(f.predict(p));
        assertTrue(payer.pay(to, 1 ether), "before deployment: a plain address takes the send");
        f.deploy(p);
        assertTrue(payer.pay(to, 1 ether), "after deployment: receive() fits the 2300-gas stipend");
        assertEq(to.balance, 2 ether);
    }

    // ---- shielding ETH -------------------------------------------------------------------------------------------------

    function test_ShieldETH_TheCommittedNoteTheTipOnce() public {
        (T.ReceiverParams memory p, bytes memory nd) = _eth();
        address payable to = payable(f.predict(p));
        vm.deal(to, 1.5 ether);
        uint256 before = nativeVault.accountedDeposits();
        vm.prank(relayer);
        uint32 leaf = f.deployAndShield(p, nd);
        assertEq(relayer.balance, TIP, "the shielder got the committed tip");
        assertEq(nativeVault.accountedDeposits() - before, 1.5 ether - TIP, "the rest is the committed note");
        assertEq(to.balance, 0, "nothing stays in the receiver");
        assertTrue(ShieldReceiver(to).tipPaid());
        // a second delivery (a provider paying in two parts): shielded again, no second tip
        vm.deal(to, 0.4 ether);
        vm.prank(relayer);
        uint32 leaf2 = f.deployAndShield(p, nd);
        assertEq(relayer.balance, TIP, "the tip is paid once");
        assertEq(nativeVault.accountedDeposits() - before, 1.9 ether - TIP);
        assertTrue(leaf2 > leaf, "a second note");
    }

    function test_DustCannotClaimTheTip() public {
        (T.ReceiverParams memory p, bytes memory nd) = _eth();
        address payable to = payable(f.predict(p));
        vm.deal(to, 1 wei); // someone sends dust before the delivery
        vm.prank(relayer);
        f.deployAndShield(p, nd);
        assertEq(relayer.balance, 0, "below the minimum: no tip");
        assertFalse(ShieldReceiver(to).tipPaid());
        vm.deal(to, MIN); // the real delivery
        vm.prank(relayer);
        f.deployAndShield(p, nd);
        assertEq(relayer.balance, TIP, "the delivery of the minimum pays the tip");
    }

    function test_WrongNoteDataAndNothingToShieldAreRefused() public {
        (T.ReceiverParams memory p, bytes memory nd) = _eth();
        vm.deal(f.predict(p), 1 ether);
        vm.expectRevert(T.NoteDataMismatch.selector);
        f.deployAndShield(p, _noteData(8));
        vm.prank(relayer);
        f.deployAndShield(p, nd);
        vm.expectRevert(T.NothingToShield.selector);
        f.deployAndShield(p, nd);
    }

    function test_AnETHReceiptUnwrapsWETH() public {
        (T.ReceiverParams memory p, bytes memory nd) = _eth();
        address payable to = payable(f.predict(p));
        vm.deal(address(this), 2 ether);
        weth.deposit{value: 2 ether}();
        weth.transfer(to, 2 ether); // a route that settles in WETH
        uint256 before = nativeVault.accountedDeposits();
        vm.prank(relayer);
        f.deployAndShield(p, nd);
        assertEq(weth.balanceOf(to), 0, "unwrapped");
        assertEq(nativeVault.accountedDeposits() - before, 2 ether - TIP, "shielded as ETH");
    }

    function test_ABrokenWETHNeverBlocksTheETH() public {
        (T.ReceiverParams memory p, bytes memory nd) = _eth();
        address payable to = payable(f.predict(p));
        vm.deal(address(this), 1 ether);
        weth.deposit{value: 1 ether}();
        weth.transfer(to, 1 ether);
        weth.setBroken(true);
        vm.deal(to, 1 ether);
        uint256 before = nativeVault.accountedDeposits();
        vm.prank(relayer);
        f.deployAndShield(p, nd);
        assertEq(nativeVault.accountedDeposits() - before, 1 ether - TIP);
    }

    // ---- shielding tokens ----------------------------------------------------------------------------------------------

    function test_ShieldUSDCAndAUSDTLikeToken() public {
        ERC20Mock usdc = new ERC20Mock();
        NoReturnToken usdt = new NoReturnToken();
        ERC20AssetVault usdcVault = ERC20AssetVault(factory.getOrCreateERC20Vault(address(usdc)));
        ERC20AssetVault usdtVault = ERC20AssetVault(factory.getOrCreateERC20Vault(address(usdt)));
        bytes memory nd = _noteData(9);
        T.ReceiverParams memory pu = _params(address(usdc), 8_000e6, 80e6, nd);
        T.ReceiverParams memory pt = _params(address(usdt), 8_000e6, 80e6, nd);
        usdc.mint(f.predict(pu), 8_100e6);
        usdt.mint(f.predict(pt), 8_000e6);
        vm.prank(relayer);
        f.deployAndShield(pu, nd);
        assertEq(usdc.balanceOf(relayer), 80e6);
        assertEq(usdcVault.accountedDeposits(), 8_020e6);
        vm.prank(relayer);
        f.deployAndShield(pt, nd);
        assertEq(usdt.balanceOf(relayer), 80e6, "a token that returns nothing (USDT) is accepted");
        assertEq(usdtVault.accountedDeposits(), 7_920e6);
    }

    function test_ARecieptWhoseAssetHasNoVaultIsNotShielded() public {
        ERC20Mock orphan = new ERC20Mock();
        bytes memory nd = _noteData(10);
        T.ReceiverParams memory p = _params(address(orphan), 1e18, 0, nd);
        orphan.mint(f.predict(p), 1e18);
        vm.expectRevert(T.NoVault.selector);
        f.deployAndShield(p, nd);
    }

    function test_AForeignTokenGoesIntoItsOwnVault() public {
        (T.ReceiverParams memory p, bytes memory nd) = _eth();
        ERC20Mock usdc = new ERC20Mock();
        ERC20AssetVault usdcVault = ERC20AssetVault(factory.getOrCreateERC20Vault(address(usdc)));
        usdc.mint(f.predict(p), 500e6);
        vm.prank(relayer);
        f.deployAndShieldToken(p, address(usdc), nd);
        assertEq(usdcVault.accountedDeposits(), 500e6, "the whole of it, as the committed note");
        assertEq(usdc.balanceOf(relayer), 0, "no tip on a foreign token");
        vm.expectRevert(T.NotAForeignToken.selector);
        f.deployAndShieldToken(p, address(weth), nd); // an ETH receipt's WETH goes through shield()
        vm.expectRevert(T.NotAForeignToken.selector);
        f.deployAndShieldToken(p, address(0), nd);
    }

    function test_AnUnsupportedTokenIsSweptOnlyToTheFallback() public {
        (T.ReceiverParams memory p,) = _eth();
        ShieldReceiver r = f.deploy(p);
        ERC20Mock orphan = new ERC20Mock();
        orphan.mint(address(r), 42e18);
        vm.prank(relayer);
        r.sweepUnsupported(address(orphan));
        assertEq(orphan.balanceOf(fallbackAddr), 42e18, "the committed fallback, never the caller");
        assertEq(orphan.balanceOf(relayer), 0);
        ERC20Mock usdc = new ERC20Mock();
        factory.getOrCreateERC20Vault(address(usdc));
        usdc.mint(address(r), 1e6);
        vm.expectRevert(T.VaultExists.selector);
        r.sweepUnsupported(address(usdc));
        vm.expectRevert(T.NotAForeignToken.selector);
        r.sweepUnsupported(address(0));
    }

    // ---- reentrancy ----------------------------------------------------------------------------------------------------

    function test_ATipRecipientCannotReenter() public {
        (T.ReceiverParams memory p, bytes memory nd) = _eth();
        ReenteringShielder evil = new ReenteringShielder(f);
        evil.arm(p, nd);
        vm.deal(f.predict(p), 2 ether);
        vm.prank(address(evil));
        vm.expectRevert(T.TipTransferFailed.selector); // its re-entry reverts, so the tip transfer fails and nothing moves
        f.deployAndShield(p, nd);
        assertEq(f.predict(p).balance, 2 ether, "nothing left the receiver");
    }

    // ---- the vector the wallet's prediction is checked against (packages/sdk/test/shield-receiver.test.ts) --------------

    /// SHIELD_VECTOR=true rewrites test/periphery/vectors/shield.json; otherwise this build must predict what it records.
    function test_ShieldVectorIsCurrent() public {
        ShieldReceiverFactory vf = new ShieldReceiverFactory(address(uint160(0xf2)), address(uint160(0xe5)));
        T.ReceiverParams memory p;
        p.receiptId = keccak256("privacy-protocol/v6/shield-vector");
        p.asset = address(0);
        p.minAmount = 2.28 ether;
        p.shieldTip = 0.002 ether;
        p.ownerCommitment = 0x1234;
        p.noteSecret = 0x5678;
        p.noteDataHash = keccak256("payload");
        p.fallbackRecipient = address(uint160(0xfa));
        string memory head = string.concat(
            '{"factory":"', vm.toString(address(vf)), '","receiptId":"', vm.toString(p.receiptId), '","asset":"', vm.toString(p.asset),
            '","minAmount":"', vm.toString(p.minAmount), '","shieldTip":"', vm.toString(p.shieldTip)
        );
        string memory json = string.concat(
            head, '","ownerCommitment":"', vm.toString(p.ownerCommitment), '","noteSecret":"', vm.toString(p.noteSecret), '","noteDataHash":"',
            vm.toString(p.noteDataHash), '","fallbackRecipient":"', vm.toString(p.fallbackRecipient), '","receiver":"', vm.toString(vf.predict(p)), '"}\n'
        );
        if (vm.envOr("SHIELD_VECTOR", false)) vm.writeFile("test/periphery/vectors/shield.json", json);
        assertEq(vm.readFile("test/periphery/vectors/shield.json"), json, "shield.json is this build's prediction");
    }

    // ---- accounting ----------------------------------------------------------------------------------------------------

    /// Whatever arrives, the tip plus the shielded note is exactly the receiver's balance.
    function testFuzz_TipPlusDepositedIsTheBalance(uint96 delivered, uint64 minRaw) public {
        vm.assume(delivered > 0);
        uint256 min = uint256(minRaw) + 100;
        uint256 tip = min / 100;
        bytes memory nd = _noteData(11);
        T.ReceiverParams memory p = _params(address(0), min, tip, nd);
        vm.deal(f.predict(p), delivered);
        uint256 before = nativeVault.accountedDeposits();
        vm.prank(relayer);
        f.deployAndShield(p, nd);
        uint256 paid = relayer.balance;
        assertEq(paid + (nativeVault.accountedDeposits() - before), delivered, "tip + deposited == balance");
        assertEq(paid, delivered >= min ? tip : 0, "the tip only on a delivery of at least the minimum");
    }
}
