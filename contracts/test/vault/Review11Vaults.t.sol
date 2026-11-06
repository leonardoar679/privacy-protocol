// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PPTestBase} from "../PPTestBase.sol";
import {CoreTypes} from "../../src/core/CoreTypes.sol";
import {ERC20AssetVault} from "../../src/vault/ERC20AssetVault.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";

/// A contract recipient whose receive() does honest work costing more than the release's push bound (PUSH_GAS, 100,000): it records the
/// payment in fresh storage — a splitter, a vesting or treasury contract, an exchange forwarder with bookkeeping.
contract HeavyReceiver {
    uint256 public received;
    mapping(uint256 => uint256) public ledger;
    uint256 public n;
    /// the gas it was handed, as it last ran to the end
    uint256 public gasAtEntry;

    receive() external payable {
        gasAtEntry = gasleft();
        for (uint256 i = 0; i < 6; i++) ledger[n++] = msg.value + i; // six fresh slots: about 6 × 22,100 gas
        received += msg.value;
    }
}

/// A token whose transfer answers a status word, Compound-style: 0 = done, non-zero = an error code — on an error it moves nothing and
/// does not revert (here: a recipient it refuses). transferFrom is standard, so deposits pass the vault's strict check.
contract StatusWordToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public refused;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function refuse(address who, bool yes) external {
        refused[who] = yes;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (uint256 err) {
        if (refused[to] || balanceOf[msg.sender] < amount) return 3; // an error code; nothing moved
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return 0; // NO_ERROR
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

interface ITokenHook {
    function onTokenReceived(address from, uint256 amount) external;
}

/// An ERC-777 / ERC-223-style token: a transfer to a registered contract calls its hook with all the gas the transfer has.
contract HookToken is ERC20Mock {
    mapping(address => bool) public registered;

    function register() external {
        registered[msg.sender] = true;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        super._transfer(from, to, amount);
        if (registered[to]) {
            try ITokenHook(to).onTokenReceived(from, amount) {} catch {
                revert("recipient refused");
            }
        }
    }
}

contract BurningHookRecipient is ITokenHook {
    bool public burn;

    function registerWith(HookToken t) external {
        t.register();
    }

    function setBurn(bool b) external {
        burn = b;
    }

    function onTokenReceived(address, uint256) external view {
        if (burn) {
            while (true) {}
        }
    }
}

/// A recipient whose token hook hands `back` units to the vault while the vault's transfer to it runs (once; then it keeps what it is paid).
contract GiveBackRecipient is ITokenHook {
    HookToken public token;
    address public vault;
    uint256 public back;

    constructor(HookToken t, address v, uint256 b) {
        token = t;
        vault = v;
        back = b;
    }

    function registerWith() external {
        token.register();
    }

    function onTokenReceived(address from, uint256) external {
        if (msg.sender == address(token) && from == vault && back > 0) {
            uint256 b = back;
            back = 0;
            token.transfer(vault, b);
        }
    }
}

/// A contract recipient whose receive() does honest work above a plain transfer's stipend and inside the release's PUSH_GAS (100,000):
/// two fresh slots of its own beside the running total (about 67,000 gas).
contract LightReceiver {
    uint256 public received;
    mapping(uint256 => uint256) public ledger;

    receive() external payable {
        ledger[1] = msg.value;
        ledger[2] = msg.value;
        received += msg.value;
    }
}

/// A hook recipient whose tokensReceived does honest work above the ETH push's bound and inside the release's TOKEN_PUSH_GAS (300,000):
/// six fresh slots.
contract HonestHookRecipient is ITokenHook {
    mapping(uint256 => uint256) public ledger;
    uint256 public n;
    uint256 public received;

    function registerWith(HookToken t) external {
        t.register();
    }

    function onTokenReceived(address, uint256 amount) external {
        for (uint256 i = 0; i < 6; i++) ledger[n++] = amount + i;
        received += amount;
    }
}

/// A hook recipient whose tokensReceived does honest work above the release's TOKEN_PUSH_GAS (300,000): fifteen fresh slots.
contract HeavyHookRecipient is ITokenHook {
    mapping(uint256 => uint256) public ledger;
    uint256 public n;
    uint256 public received;

    function registerWith(HookToken t) external {
        t.register();
    }

    /// the gas it was handed, as it last ran to the end
    uint256 public gasAtEntry;

    function onTokenReceived(address, uint256 amount) external {
        gasAtEntry = gasleft();
        for (uint256 i = 0; i < 15; i++) ledger[n++] = amount + i;
        received += amount;
    }
}

/// The eleventh review round (2026-11-04): the vaults' payouts. G11-2 — a claim forwards its caller's gas (the fifth round's push bound
/// had capped the claim too, and a recipient needing more was never paid); G11-3 — an ERC-20 payout is paid when the vault's own balance
/// fell at all, and is a claim only when nothing left (a status-code token's error word had read as paid: Released, nothing moved, no
/// claim; the slice's first critique: "fell by the whole amount" paid a recipient that handed one unit back twice); G11-5 — the release's
/// token call is bounded as the ETH push is (a hook token's recipient had run the relayer's whole transact out of gas).
contract Review11VaultsTest is PPTestBase {
    address internal alice = address(0xA11CE);

    function test_G11_2_aClaimForwardsItsCallersGas_aHeavyRecipientIsPaid() public {
        _deployCore();
        _depositNative(alice, 3 ether, 1);
        HeavyReceiver r = new HeavyReceiver();
        _transact(_withdrawPI(address(nativeVault), address(r), 1 ether, 201, 202));
        assertEq(nativeVault.claimable(address(r)), 1 ether, "the release's push is bounded: booked as claimable");
        assertEq(r.received(), 0, "not paid by the push");
        (bool ok,) = address(nativeVault).call{gas: 10_000_000}(abi.encodeCall(nativeVault.claim, (address(r))));
        assertTrue(ok, "claimed");
        assertEq(r.received(), 1 ether, "paid by the claim");
        // nearly all of the caller's gas, never a fixed bound above the release's (the second critique of slice 5)
        assertTrue(r.gasAtEntry() > 9_000_000, "the claim forwards its caller's gas");
        assertEq(nativeVault.claimable(address(r)), 0, "the claim is spent");
        assertTrue(nativeVault.isSolvent(), "solvent");
    }

    function test_G11_3_aStatusWordErrorIsAClaim_neverReleasedWithNothingPaid() public {
        _deployCore();
        StatusWordToken t = new StatusWordToken();
        ERC20AssetVault v = ERC20AssetVault(factory.getOrCreateERC20Vault(address(t)));
        address bob = address(0xB0B);
        t.mint(alice, 10 ether);
        vm.prank(alice);
        t.approve(address(v), 10 ether);
        _depositERC20(v, alice, 5 ether, 9);
        t.refuse(bob, true); // the token's own refusal, answered with an error code
        _transact(_withdrawPI(address(v), bob, 2 ether, 301, 302));
        assertTrue(core.isNullifierSpent(301), "the notes are spent");
        assertEq(t.balanceOf(bob), 0, "bob received nothing");
        assertEq(v.claimable(bob), 2 ether, "and holds a claim: the payout the token refused is owed");
        assertEq(t.balanceOf(address(v)), 5 ether, "the tokens stay in the vault, owed to bob");
        // once the token takes bob, the claim pays
        t.refuse(bob, false);
        v.claim(bob);
        assertEq(t.balanceOf(bob), 2 ether, "paid by the claim");
        assertEq(v.claimable(bob), 0);
    }

    function test_G11_5_aHookTokensRecipientCannotRevertTheRelayersTransact() public {
        _deployCore();
        HookToken token = new HookToken();
        ERC20AssetVault vault = ERC20AssetVault(factory.getOrCreateERC20Vault(address(token)));
        token.mint(alice, 10 ether);
        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
        _depositERC20(vault, alice, 5 ether, 7);
        BurningHookRecipient r = new BurningHookRecipient();
        r.registerWith(token);
        // the estimate: the recipient behaves, as it can while eth_estimateGas runs
        (uint256 estimate, bool ok0) = _gasOf(_withdrawPI(address(vault), address(r), 1 ether, 101, 102));
        assertTrue(ok0, "a behaving hook is paid");
        assertEq(token.balanceOf(address(r)), 1 ether);
        // then it burns what it is handed: the relayer's limit — the estimate with a 50 % margin and 300k on top — still completes
        r.setBurn(true);
        bool ok = _limited(_withdrawPI(address(vault), address(r), 1 ether, 103, 104), (estimate * 3) / 2 + 300_000);
        assertTrue(ok, "the token call is bounded: the transact completes");
        assertTrue(core.isNullifierSpent(103), "the withdrawal happened");
        assertEq(vault.claimable(address(r)), 1 ether, "the payout the hook refused is a claim");
        // the claim forwards its caller's gas: a recipient that stops burning is paid
        r.setBurn(false);
        vault.claim(address(r));
        assertEq(token.balanceOf(address(r)), 2 ether, "paid by the claim");
    }

    /// The first critique of slice 5: "paid" is a balance that fell, by anything — a payout made, one unit handed back during the call, had
    /// read as unpaid under "fell by the whole amount", booked as a claim beside the payout and paid twice from the other depositors' tokens.
    function test_G11_3_aRecipientHandingOneUnitBackKeepsOnePayout_neverAClaimBesideIt() public {
        (HookToken token, ERC20AssetVault vault) = _hookVault();
        GiveBackRecipient r = new GiveBackRecipient(token, address(vault), 1);
        r.registerWith();
        _transact(_withdrawPI(address(vault), address(r), 1 ether, 401, 402));
        assertEq(token.balanceOf(address(r)), 1 ether - 1, "paid, less the unit it handed back");
        assertEq(vault.claimable(address(r)), 0, "no claim beside the payout");
        assertTrue(vault.isSolvent(), "solvent: one payout for one withdrawal");
    }

    function test_G11_3_aRecipientHandingEverythingBackIsAClaim_paidOnce() public {
        (HookToken token, ERC20AssetVault vault) = _hookVault();
        GiveBackRecipient r = new GiveBackRecipient(token, address(vault), 1 ether);
        r.registerWith();
        _transact(_withdrawPI(address(vault), address(r), 1 ether, 403, 404));
        assertEq(token.balanceOf(address(r)), 0, "it handed the whole payout back");
        assertEq(vault.claimable(address(r)), 1 ether, "nothing left the vault: a claim");
        vault.claim(address(r));
        assertEq(token.balanceOf(address(r)), 1 ether, "paid once, by the claim");
        assertEq(vault.claimable(address(r)), 0);
        assertTrue(vault.isSolvent(), "solvent");
    }

    /// G11-2 on the token vault (the first critique of slice 5: only the ETH half had a test): a payout the bounded release turned into a
    /// claim is paid by the claim, which forwards its caller's gas.
    function test_G11_2_anErc20ClaimForwardsItsCallersGas_aHeavyHookIsPaid() public {
        (HookToken token, ERC20AssetVault vault) = _hookVault();
        HeavyHookRecipient r = new HeavyHookRecipient();
        r.registerWith(token);
        _transact(_withdrawPI(address(vault), address(r), 1 ether, 405, 406));
        assertEq(vault.claimable(address(r)), 1 ether, "the bounded release books it");
        (bool ok,) = address(vault).call{gas: 10_000_000}(abi.encodeCall(vault.claim, (address(r))));
        assertTrue(ok, "claimed");
        assertEq(token.balanceOf(address(r)), 1 ether);
        assertTrue(r.gasAtEntry() > 9_000_000, "the claim forwards its caller's gas, never a fixed bound above the release's");
        assertEq(vault.claimable(address(r)), 0);
        assertTrue(vault.isSolvent(), "solvent");
    }

    /// The release's bounds from below (the third critique of slice 5: only a bound too large was caught — a TOKEN_PUSH_GAS lowered to the ETH
    /// push's 100,000 passed every test): a recipient doing honest bookkeeping inside the bound is paid by the release, no claim booked.
    function test_G11_5_anHonestHookInsideTheBoundIsPaidByTheRelease_noClaim() public {
        (HookToken token, ERC20AssetVault vault) = _hookVault();
        HonestHookRecipient probe = new HonestHookRecipient();
        uint256 g = gasleft();
        probe.onTokenReceived(address(0), 1);
        assertTrue(g - gasleft() > 100_000, "its hook needs more than the ETH push's bound");
        HonestHookRecipient r = new HonestHookRecipient();
        r.registerWith(token);
        _transact(_withdrawPI(address(vault), address(r), 1 ether, 407, 408));
        assertEq(token.balanceOf(address(r)), 1 ether, "paid by the release");
        assertEq(r.received(), 1 ether, "its hook ran to the end");
        assertEq(vault.claimable(address(r)), 0, "no claim");
    }

    function test_G11_5_aLightReceiverInsideThePushBoundIsPaidByTheRelease_noClaim() public {
        _deployCore();
        _depositNative(alice, 3 ether, 3);
        LightReceiver probe = new LightReceiver();
        uint256 g = gasleft();
        (bool sent,) = address(probe).call{value: 1}("");
        assertTrue(sent && g - gasleft() > 60_000, "its receive() needs far more than a transfer's 2,300");
        LightReceiver r = new LightReceiver();
        _transact(_withdrawPI(address(nativeVault), address(r), 1 ether, 409, 410));
        assertEq(r.received(), 1 ether, "paid by the release");
        assertEq(nativeVault.claimable(address(r)), 0, "no claim");
    }

    /// The property behind the balance rule (the second critique of slice 5: two points of it had been tested — one unit back, all of it back
    /// — and a rule with a tolerance between them passed): whatever a hook recipient hands back inside its payout, from nothing to more than
    /// the payout (its own tokens too), its whole take is at most the amount and the vault stays solvent.
    function testFuzz_G11_3_aRecipientsWholeTakeIsAtMostItsAmount_whateverItHandsBack(uint256 back) public {
        _handBack(back % (2 ether + 1));
    }

    function test_G11_3_aRecipientsWholeTakeIsAtMostItsAmount_atTheEdges() public {
        uint256[10] memory backs = [uint256(0), 1, 2, 3, 0.5 ether, 0.5 ether + 1, 1 ether - 1, 1 ether, 1 ether + 1, 2 ether];
        for (uint256 k = 0; k < backs.length; k++) _handBack(backs[k]);
    }

    function _handBack(uint256 back) internal {
        (HookToken token, ERC20AssetVault vault) = _hookVault();
        GiveBackRecipient r = new GiveBackRecipient(token, address(vault), back);
        r.registerWith();
        token.mint(address(r), 1 ether); // its own tokens, for a hand-back beyond the payout
        _transact(_withdrawPI(address(vault), address(r), 1 ether, 501, 502));
        if (vault.claimable(address(r)) > 0) vault.claim(address(r));
        assertTrue(token.balanceOf(address(r)) <= 2 ether, "its whole take is at most the amount, over its own 1 ether");
        assertTrue(vault.isSolvent(), "solvent");
    }

    function _hookVault() internal returns (HookToken token, ERC20AssetVault vault) {
        _deployCore();
        token = new HookToken();
        vault = ERC20AssetVault(factory.getOrCreateERC20Vault(address(token)));
        token.mint(alice, 10 ether);
        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
        _depositERC20(vault, alice, 5 ether, 11);
    }

    function _gasOf(CoreTypes.PublicInputs memory pi) internal returns (uint256 used, bool ok) {
        _accept(pi);
        bytes memory call = abi.encodeCall(core.transact, ("", pi, _noteData(0), _noteData(1), _noteData(2)));
        uint256 g = gasleft();
        (ok,) = address(core).call(call);
        used = g - gasleft();
    }

    function _limited(CoreTypes.PublicInputs memory pi, uint256 limit) internal returns (bool ok) {
        _accept(pi);
        bytes memory call = abi.encodeCall(core.transact, ("", pi, _noteData(0), _noteData(1), _noteData(2)));
        (ok,) = address(core).call{gas: limit}(call);
    }
}
