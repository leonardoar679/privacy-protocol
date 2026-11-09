// The twelfth review round, 2026-11-06, slice 12c part 2b — the guards. F12-4: the engine reads Across's exclusivity as the wallet bounds it at
// signing (D11-10: no exclusive relayer, or one whose window ends within 600 s) — the direct Across adapter, the Across swap leg and LI.FI's
// Across V4 facet put the window on their quotes, and the competition sets one the wallet would refuse aside (engine quoteAll, the API's tests);
// never refused where a committed order's call is checked (ZE's critique: there the wallet's own check before a delayed one-confirm funding
// stops the order unfunded). F12-5:
// the guest guard reads the destination chain's halt from the same THORNode answers, as the order guard does (D11-9), its own type for the
// screen's words. F12-8: a guest's Ethereum destination is never a registry token's own contract.
import { afterEach, describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionData, getAddress, padHex, parseAbi, type Address, type Hex } from "viem";
import { ACROSS_DESTINATION, PINNED, bytes32Of, checkProviderCall, ProviderCallUnverified, thorAsset, type CallExpectation, type InboundLookup } from "@privacy-wallet/sdk/providerCall";
import { checkGuestInstruction, GuestDestinationHalted } from "@privacy-wallet/sdk/guestGuard";
import { AcrossAdapter, SPOKE_POOL, WETH as ENGINE_WETH, encodeDepositV3 } from "@privacy-wallet/swap-engine/adapters/across";
import { acrossSwapPins, verifyAcrossSwapCall } from "@privacy-wallet/swap-engine/adapters/acrossSwap";
import { LIFI_DIAMOND, verifyLifiTransaction } from "@privacy-wallet/swap-engine/adapters/lifi";
import { exclusivityWindow } from "@privacy-wallet/swap-engine/adapters/acrossBounds";
import { parseDestination } from "@privacy-wallet/protocol/wallet/destinations";
import { guestKnownRecipients } from "../src/features/recipients";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ESCROW = getAddress("0x2b8dc27605bf11214247ae11a013fcadf2c1cb65");
const RELAYER = getAddress("0x000000000000000000000000000000000000bad1");
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const DEST_EVM = getAddress("0x1111111111111111111111111111111111111111");
const ETH = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const USDC_REF = { chain: "ethereum", asset: USDC, decimals: 6, symbol: "USDC" };
const ETH_BASE = { chain: "base", asset: "native", decimals: 18, symbol: "ETH" };
const now = () => Math.floor(Date.now() / 1000);
const NOW = now();
const NET = 10n ** 18n;
const OUT = 700_000_000_000_000_000n;
const NET_USDC = 2_000_000_000n;

const PERIPHERY_ABI = parseAbi([
  "struct Fees { uint256 amount; address recipient; }",
  "struct BaseDepositData { address inputToken; bytes32 outputToken; uint256 outputAmount; address depositor; bytes32 recipient; uint256 destinationChainId; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }",
  "struct SwapAndDepositData { Fees submissionFees; BaseDepositData depositData; address swapToken; address exchange; uint8 transferType; uint256 swapTokenAmount; uint256 minExpectedInputTokenAmount; bytes routerCalldata; bool enableProportionalAdjustment; address spokePool; uint256 nonce; }",
  "function swapAndBridge(SwapAndDepositData swapAndDepositData) payable",
]);
const HANDLER_MESSAGE = [{ type: "tuple", components: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "callData", type: "bytes" }, { name: "value", type: "uint256" }] }, { name: "fallbackRecipient", type: "address" }] }] as const;
const H = parseAbi(["function drainLeftoverTokens(address token, address destination)", "function makeCallWithBalance(address target, bytes callData, uint256 value, (address token, uint256 offset)[] replacement)", "function withdraw(uint256 wad)"]);
const HANDLER = ACROSS_DESTINATION.handler.base;
const WETH_B = ENGINE_WETH.base as Address;
const calls = [
  { target: HANDLER, value: 0n, callData: encodeFunctionData({ abi: H, functionName: "makeCallWithBalance", args: [WETH_B, encodeFunctionData({ abi: H, functionName: "withdraw", args: [0n] }), 0n, [{ token: WETH_B, offset: 4n }]] }) },
  { target: HANDLER, value: 0n, callData: encodeFunctionData({ abi: H, functionName: "drainLeftoverTokens", args: [ZERO, DEST_EVM] }) },
];
const leg = (exclusiveRelayer: Hex, exclusivityParameter: number) =>
  encodeFunctionData({
    abi: PERIPHERY_ABI,
    functionName: "swapAndBridge",
    args: [
      {
        submissionFees: { amount: 0n, recipient: ZERO },
        depositData: {
          inputToken: ENGINE_WETH.ethereum as Address, outputToken: bytes32Of("base", WETH_B), outputAmount: OUT, depositor: ESCROW, recipient: bytes32Of("base", HANDLER), destinationChainId: 8453n,
          exclusiveRelayer, quoteTimestamp: NOW - 10, fillDeadline: NOW + 7200, exclusivityParameter, message: encodeAbiParameters(HANDLER_MESSAGE, [{ calls, fallbackRecipient: ZERO }]),
        },
        swapToken: USDC, exchange: PINNED.lifiDiamond, transferType: 0, swapTokenAmount: NET_USDC, minExpectedInputTokenAmount: OUT, routerCalldata: "0xabcd" as Hex, enableProportionalAdjustment: true, spokePool: PINNED.acrossSpokePool, nonce: 0n,
      } as never,
    ],
  });
const LIFI_ABI = parseAbi([
  "struct BridgeData { bytes32 transactionId; string bridge; string integrator; address referrer; address sendingAssetId; address receiver; uint256 minAmount; uint256 destinationChainId; bool hasSourceSwaps; bool hasDestinationCall; }",
  "struct AcrossV4Data { bytes32 receiverAddress; bytes32 refundAddress; bytes32 sendingAssetId; bytes32 receivingAssetId; uint256 outputAmount; uint128 outputAmountMultiplier; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }",
  "function startBridgeTokensViaAcrossV4(BridgeData _bridgeData, AcrossV4Data _acrossData) payable",
]);
const lifiAcross = (exclusiveRelayer: Hex, exclusivityParameter: number) =>
  encodeFunctionData({
    abi: LIFI_ABI,
    functionName: "startBridgeTokensViaAcrossV4",
    args: [
      { transactionId: padHex("0x01", { size: 32 }), bridge: "across", integrator: "lifi-api", referrer: ZERO, sendingAssetId: ZERO, receiver: DEST_EVM, minAmount: NET, destinationChainId: 8453n, hasSourceSwaps: false, hasDestinationCall: false } as never,
      {
        receiverAddress: bytes32Of("base", DEST_EVM), refundAddress: bytes32Of("ethereum", ESCROW), sendingAssetId: bytes32Of("ethereum", ENGINE_WETH.ethereum as Address), receivingAssetId: bytes32Of("base", WETH_B), outputAmount: OUT,
        outputAmountMultiplier: 10n ** 18n, exclusiveRelayer, quoteTimestamp: NOW - 10, fillDeadline: NOW + 7200, exclusivityParameter, message: "0x",
      } as never,
    ],
  });
const longRelayer = bytes32Of("base", RELAYER);
const noRelayer = padHex("0x", { size: 32 });
const swapReq = { from: USDC_REF, to: ETH_BASE, amount: NET_USDC, destination: DEST_EVM, source: ESCROW, slippageBps: 50 } as never;
const withVaults = <T>(run: () => T): T => {
  const saved = process.env.ERC20_VAULTS;
  process.env.ERC20_VAULTS = "";
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env.ERC20_VAULTS;
    else process.env.ERC20_VAULTS = saved;
  }
};
const swapPins = () => acrossSwapPins(swapReq, { spokePool: SPOKE_POOL, weth: ENGINE_WETH, chainId: { ethereum: 1, base: 8453, arbitrum: 42161, optimism: 10 } } as never);
const swapLeg = (exclusiveRelayer: Hex, parameter: number) => withVaults(() => verifyAcrossSwapCall(swapReq, { to: PINNED.acrossPeriphery, data: leg(exclusiveRelayer, parameter), value: 0n } as never, swapPins()));
const lifiLeg = (exclusiveRelayer: Hex, parameter: number) =>
  verifyLifiTransaction(
    { from: ETH as never, to: ETH_BASE as never, amount: NET, destination: DEST_EVM, source: ESCROW, slippageBps: 50 },
    { tool: "across", transactionRequest: { to: LIFI_DIAMOND.ethereum, data: lifiAcross(exclusiveRelayer, parameter), value: "0x" + NET.toString(16), chainId: 1 }, action: { fromAddress: ESCROW, toAddress: DEST_EVM, fromChainId: 1, toChainId: 8453 }, estimate: { toAmountMin: OUT.toString() } },
  );
const wallet = (calldata: Hex, provider: string, value: bigint, from: typeof ETH | typeof USDC_REF, net: bigint) =>
  checkProviderCall({ provider, value, calldata }, { escrow: ESCROW, from: from as never, to: ETH_BASE as never, destination: DEST_EVM, net, policy: "best-privacy", now: now(), pooled: [] } as CallExpectation);

describe("F12-4: the engine reads Across's exclusivity as the wallet bounds it", () => {
  it("the window, at the SpokePool's edges: none without an exclusive relayer; up to a year read as seconds, past it as a timestamp", () => {
    expect(exclusivityWindow(ZERO, 3600, NOW)).toBeNull();
    expect(exclusivityWindow(new Uint8Array(32), 3600, NOW)).toBeNull();
    expect(exclusivityWindow(RELAYER, 600, NOW)).toBe(600);
    expect(exclusivityWindow(RELAYER, 601, NOW)).toBe(601);
    expect(exclusivityWindow(RELAYER, 100_000, NOW)).toBe(100_000);
    expect(exclusivityWindow(RELAYER, 31_536_000, NOW), "a year: still seconds").toBe(31_536_000);
    expect(exclusivityWindow(RELAYER, 31_536_001, NOW), "past a year: a timestamp, long gone").toBe(31_536_001 - NOW);
    expect(exclusivityWindow(RELAYER, NOW + 300, NOW)).toBe(300);
  });

  it("the Across swap leg's check returns the window, never refusing it — the prepare of a committed order is checked there, and the wallet refuses at signing", async () => {
    expect(swapLeg(longRelayer, 3600).exclusivitySeconds).toBe(3600);
    expect(swapLeg(longRelayer, 600).exclusivitySeconds).toBe(600);
    expect(swapLeg(noRelayer, 3600).exclusivitySeconds).toBeUndefined();
    const t = now() + 3600;
    const read = swapLeg(longRelayer, t).exclusivitySeconds!;
    expect(read >= 3599 && read <= 3600, `a timestamp an hour ahead read as ${read} s`).toBe(true);
    // the wallet's own bound, in step at the edges: 600 s signed, 601 s refused (ZF's critique: the engine takes 600 s)
    expect((await wallet(leg(longRelayer, 600), PINNED.acrossPeriphery, 0n, USDC_REF, NET_USDC)).minOut).toBe(OUT);
    await expect(wallet(leg(longRelayer, 601), PINNED.acrossPeriphery, 0n, USDC_REF, NET_USDC)).rejects.toThrow(/only one relayer may fill the deposit for 601 s/);
    await expect(wallet(leg(longRelayer, 3600), PINNED.acrossPeriphery, 0n, USDC_REF, NET_USDC)).rejects.toThrow(/only one relayer/);
  });

  it("LI.FI's Across V4 facet's check returns the window too (words 6 and 9) — as the wallet reads the same call", async () => {
    expect(lifiLeg(longRelayer, 3600).exclusivitySeconds).toBe(3600);
    expect(lifiLeg(longRelayer, 600).exclusivitySeconds).toBe(600);
    expect(lifiLeg(noRelayer, 3600).exclusivitySeconds).toBeUndefined();
    expect(lifiLeg(longRelayer, 31_536_000).exclusivitySeconds).toBe(31_536_000);
    expect((await wallet(lifiAcross(longRelayer, 600), PINNED.lifiDiamond, NET, ETH, NET)).minOut).toBe(OUT);
    await expect(wallet(lifiAcross(longRelayer, 100_000), PINNED.lifiDiamond, NET, ETH, NET)).rejects.toThrow(/only one relayer may fill the deposit for 100000 s/);
    await expect(wallet(lifiAcross(longRelayer, 31_536_000), PINNED.lifiDiamond, NET, ETH, NET)).rejects.toThrow(/only one relayer/);
  });

  it("the direct route's call, as the wallet reads it at the same edge: 600 s signed, 601 s refused", async () => {
    const direct = (relayer: Address, exclusivity: number) =>
      encodeDepositV3({ depositor: ESCROW, recipient: DEST_EVM, inputToken: ENGINE_WETH.ethereum, outputToken: ENGINE_WETH.base, inputAmount: NET, outputAmount: OUT, destinationChainId: 8453, exclusiveRelayer: relayer, quoteTimestamp: NOW - 10, fillDeadline: NOW + 6 * 3600, exclusivityDeadline: exclusivity }) as Hex;
    expect((await wallet(direct(RELAYER, 600), PINNED.acrossSpokePool, NET, ETH, NET)).minOut).toBe(OUT);
    await expect(wallet(direct(RELAYER, 601), PINNED.acrossSpokePool, NET, ETH, NET)).rejects.toThrow(/only one relayer may fill the deposit for 601 s/);
  });

  describe("the Across adapter's quotes carry it, for the competition", () => {
    const real = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = real;
    });
    const suggestedFees = (exclusiveRelayer: string, exclusivityDeadline: number) => {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            outputAmount: OUT.toString(), totalRelayFee: { pct: "0", total: "1000" }, lpFee: { pct: "0", total: "10" }, relayerGasFee: { total: "500" }, relayerCapitalFee: { total: "490" },
            exclusiveRelayer, exclusivityDeadline, timestamp: String(NOW), spokePoolAddress: SPOKE_POOL.ethereum, fillDeadline: String(NOW + 7200), isAmountTooLow: false, estimatedFillTimeSec: 30,
          }),
          { status: 200 },
        )) as typeof fetch;
    };
    it("the direct route: an exclusive relayer's window on the quote, none without one", async () => {
      const quote = () => new AcrossAdapter().quote({ from: ETH as never, to: ETH_BASE as never, amount: NET, destination: DEST_EVM, source: ESCROW, slippageBps: 50 });
      suggestedFees(RELAYER, 3600);
      expect((await quote()).exclusivitySeconds).toBe(3600);
      suggestedFees(RELAYER, 600);
      expect((await quote()).exclusivitySeconds).toBe(600);
      suggestedFees(ZERO, 3600);
      expect((await quote()).exclusivitySeconds).toBeUndefined();
      // a deadline past a year: a timestamp, read against the clock in seconds
      suggestedFees(RELAYER, now() + 3600);
      const read = (await quote()).exclusivitySeconds!;
      expect(read >= 3599 && read <= 3600, `a timestamp an hour ahead read as ${read} s`).toBe(true);
    });
    it("the swap route (a swap, then the bridge): the window of the call it is answered", async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ swapTx: { to: PINNED.acrossPeriphery, data: leg(longRelayer, 3600), value: "0", chainId: 1 }, crossSwapType: "anyToBridgeable", expectedOutputAmount: OUT.toString(), expectedFillTime: 30, quoteExpiryTimestamp: NOW + 600 }), {
          status: 200,
        })) as typeof fetch;
      const q = await withVaults(() => new AcrossAdapter().quote({ ...(swapReq as object), source: undefined } as never));
      expect(q.exclusivitySeconds).toBe(3600);
    });
  });
});

describe("F12-5: the guest guard reads the destination chain's halt, as the order guard does", () => {
  const BTC = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
  const VAULT_BTC = "bc1qmanydifferentvaultaddressxxxxxxxxxxxxxxx";
  const at = 1_790_000_000;
  const guest = (haltedChains: string[]) => {
    const inbound: InboundLookup = async (chain) => ({ address: chain === "BTC" ? VAULT_BTC : "", halted: false, agreeing: ["a", "b", "c"], haltedChains });
    return checkGuestInstruction(
      { provider: "thorchain", ingress: { to: VAULT_BTC, memo: `=:${thorAsset(ETH as never)}:${DEST_EVM}:5000000`, amount: "1000000", expiresAt: at + 600 } },
      { from: BTC as never, to: ETH as never, destination: DEST_EVM, amount: 1_000_000n, approvedMin: 0n, inbound, now: at },
    );
  };
  it("a BTC → ETH instruction while the gateways report ETH halted is not shown now — its own refusal, a check not made (asked again)", async () => {
    const e = await guest(["ETH"]).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GuestDestinationHalted);
    expect(e).toBeInstanceOf(ProviderCallUnverified);
    expect((e as GuestDestinationHalted).chain).toBe("ETH");
  });
  it("another chain halted, or none, leaves it shown", async () => {
    for (const halted of [["BSC"], []]) expect((await guest(halted)).depositAddress, JSON.stringify(halted)).toBe(VAULT_BTC);
  });
});

describe("F12-8: a guest's Ethereum destination is never a token's own contract", () => {
  it("the registry's Ethereum token contracts are refused, USDC's among them; a plain address is taken", () => {
    const known = guestKnownRecipients();
    expect(known.some((k) => k.address.toLowerCase() === USDC.toLowerCase() && k.kind === "token")).toBe(true);
    expect(parseDestination("evm", USDC, known).ok).toBe(false);
    expect(parseDestination("evm", DEST_EVM, known).ok).toBe(true);
    expect(parseDestination("evm", USDC).ok, "without the list, as before").toBe(true);
  });
});
