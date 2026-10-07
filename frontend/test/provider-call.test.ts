// The wallet's own check of the provider call the one-time order key signs (src/sdk/providerCall.ts).
// Honest calls are built with the swap service's OWN encoders (services/private-swap adapters), so the
// two independent implementations must agree; then every way a dishonest service could bend a call —
// another receiver, a refund that does not come back, another asset or amount, fees, a lowered
// minimum, a facet or contract the wallet cannot read — is refused, and a lowered minimum is reported
// against what the user approved. Chainflip's honest call is the one its public backend emitted
// (services/private-swap/test/chainflip-unit.test.ts). Offline: THORNode answers are stubbed.
import { describe, it, expect } from "vitest";
import { encodeFunctionData, getAddress, padHex, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import { PINNED, ProviderCallMismatch, MinimumMoved, bytes32Of, checkMinimum, checkProviderCall, decodeCfParameters, thorAsset, thornodeInbound, type CallExpectation, type InboundLookup } from "../src/sdk/providerCall";
import { buildMemo, encodeDepositWithExpiry, thorAsset as engineThorAsset } from "../../services/private-swap/src/adapters/thorchain";
import { CF_ASSET_ID, CF_CHAIN_ID, CHAINFLIP_VAULT_ETHEREUM, SEL_X_SWAP_NATIVE, SEL_X_SWAP_TOKEN, decodeVaultSwapCalldata, minOutFromPrice } from "../../services/private-swap/src/adapters/chainflip";
import { SPOKE_POOL, WETH as ENGINE_WETH, encodeDepositV3 } from "../../services/private-swap/src/adapters/across";
import { MAYAN_FAST_MCTP, MAYAN_FORWARDER, SEL_CREATE_ORDER, SEL_FORWARD_ERC20, SEL_SWAP_AND_FORWARD_ETH, addressHex32, encodeCreateOrder } from "../../services/private-swap/src/adapters/mayan";
import { LIFI_DIAMOND, SEL_ACROSS_V4, SEL_ACROSS_V4_SWAP, SEL_MAYAN, SEL_MAYAN_SWAP, verifyLifiTransaction } from "../../services/private-swap/src/adapters/lifi";
import { encodeCall } from "../../services/private-swap/src/abi";
import type { AssetRef } from "../src/sdk/swapService";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ESCROW = getAddress("0x2b8dc27605bf11214247ae11a013fcadf2c1cb65");
const ATTACKER = getAddress("0x000000000000000000000000000000000000bad1");
const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const USDC: AssetRef = { chain: "ethereum", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" };
const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const SOL: AssetRef = { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" };
const ETH_BASE: AssetRef = { chain: "base", asset: "native", decimals: 18, symbol: "ETH" };
const USDC_BASE: AssetRef = { chain: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" };
const DEST_BTC = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const DEST_EVM = getAddress("0x1111111111111111111111111111111111111111");
const DEST_SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const NET = 10n ** 18n;
const NOW = 1_790_000_000;
const expectation = (over: Partial<CallExpectation> = {}): CallExpectation => ({ escrow: ESCROW, from: ETH, to: BTC, destination: DEST_BTC, net: NET, policy: "best-privacy", now: NOW, ...over });
const refused = async (p: Promise<unknown>, field: RegExp) => { await expect(p).rejects.toThrow(ProviderCallMismatch); await expect(p).rejects.toThrow(field); };

describe("the wallet's pins and notation equal the swap service's", () => {
  it("provider contracts, Chainflip ids, WETH, THORChain asset notation, selectors", () => {
    expect(PINNED.chainflipVault.toLowerCase()).toBe(CHAINFLIP_VAULT_ETHEREUM);
    expect(PINNED.lifiDiamond.toLowerCase()).toBe(LIFI_DIAMOND.ethereum);
    expect(PINNED.mayanForwarder.toLowerCase()).toBe(MAYAN_FORWARDER);
    expect(PINNED.mayanFastMctp.toLowerCase()).toBe(MAYAN_FAST_MCTP);
    expect(PINNED.acrossSpokePool.toLowerCase()).toBe(SPOKE_POOL.ethereum);
    expect(CF_CHAIN_ID.Bitcoin).toBe(3);
    expect(CF_ASSET_ID["Bitcoin.BTC"]).toBe(5);
    expect(ENGINE_WETH.base.toLowerCase()).toBe("0x4200000000000000000000000000000000000006");
    for (const a of [BTC, SOL, ETH_BASE, USDC_BASE]) expect(thorAsset(a)).toBe(engineThorAsset(a as any));
    const sel = (abi: string) => toFunctionSelector(abi);
    expect(sel("function xSwapNative(uint32,bytes,uint32,bytes)")).toBe(SEL_X_SWAP_NATIVE);
    expect(sel("function xSwapToken(uint32,bytes,uint32,address,uint256,bytes)")).toBe(SEL_X_SWAP_TOKEN);
    expect(sel("function swapAndForwardEth(uint256,address,bytes,address,uint256,address,bytes)")).toBe(SEL_SWAP_AND_FORWARD_ETH);
    expect(sel("function forwardERC20(address,uint256,(uint256,uint256,uint8,bytes32,bytes32),address,bytes)")).toBe(SEL_FORWARD_ERC20);
    expect(sel("function createOrder(address,uint256,uint256,uint32,uint32,(uint8,bytes32,bytes32,uint64,uint64,uint64,uint64,uint64,bytes32,uint8))")).toBe(SEL_CREATE_ORDER);
    expect([toFunctionSelector(LIFI.startAcross), toFunctionSelector(LIFI.swapAcross), toFunctionSelector(LIFI.startMayan), toFunctionSelector(LIFI.swapMayan)]).toEqual([SEL_ACROSS_V4, SEL_ACROSS_V4_SWAP, SEL_MAYAN, SEL_MAYAN_SWAP]);
  });
});

// ---- THORChain ---------------------------------------------------------------------------------------
describe("THORChain: router pinned, vault from the gateways, the memo pays the fresh address and refunds the escrow", () => {
  const VAULT = getAddress("0x755e7849e47cbbfaf0efe8c76a2def21dd4a85bb");
  const LIMIT = 3_000_000n;
  const inbound = (over: Partial<Awaited<ReturnType<InboundLookup>>> = {}): InboundLookup => async () => ({ address: VAULT, router: PINNED.thorchainRouter, halted: false, agreeing: ["a", "b", "c"], ...over });
  const call = (o: { vault?: string; asset?: string; amount?: bigint; memo?: string; expiry?: bigint; value?: bigint } = {}) => ({
    provider: PINNED.thorchainRouter, value: o.value ?? NET,
    calldata: encodeDepositWithExpiry(o.vault ?? VAULT, o.asset ?? ZERO, o.amount ?? NET, o.memo ?? buildMemo(thorAsset(BTC), DEST_BTC, LIMIT, ESCROW), o.expiry ?? BigInt(NOW + 600)) as Hex,
  });

  it("the engine's call passes: minimum = the memo limit, refunds to the escrow", async () => {
    const c = await checkProviderCall(call(), expectation(), { inbound: inbound() });
    expect(c).toMatchObject({ provider: "thorchain", receiver: DEST_BTC, minOut: LIMIT, refundTo: "escrow" });
    expect(() => checkMinimum(c, LIMIT)).not.toThrow();
    expect(() => checkMinimum(c, LIMIT + 1n)).toThrow(MinimumMoved);
  });
  it("an ERC-20 order deposits the token and forwards no ETH", async () => {
    const e = expectation({ from: USDC, net: 1_000_000_000n });
    await expect(checkProviderCall(call({ asset: USDC.asset, amount: 1_000_000_000n, value: 0n }), e, { inbound: inbound() })).resolves.toMatchObject({ minOut: LIMIT });
    await refused(checkProviderCall(call({ asset: ZERO, amount: 1_000_000_000n, value: 0n }), e, { inbound: inbound() }), /asset/);
  });
  it("refuses: another vault, router or halted inbound; another receiver, refund, asset, limit form; another amount or value", async () => {
    const e = expectation();
    await refused(checkProviderCall(call({ vault: ATTACKER }), e, { inbound: inbound() }), /vault/);
    await refused(checkProviderCall(call(), e, { inbound: inbound({ router: ATTACKER }) }), /router/);
    await refused(checkProviderCall(call(), e, { inbound: inbound({ halted: true }) }), /inbound/);
    await refused(checkProviderCall(call({ memo: buildMemo(thorAsset(BTC), "bc1qattacker", LIMIT, ESCROW) }), e, { inbound: inbound() }), /receiver/);
    await refused(checkProviderCall(call({ memo: buildMemo(thorAsset(BTC), DEST_BTC, LIMIT, ATTACKER) }), e, { inbound: inbound() }), /refund/);
    await refused(checkProviderCall(call({ memo: buildMemo(thorAsset(BTC), DEST_BTC, LIMIT) }), e, { inbound: inbound() }), /memo/); // no refund address: THORChain would refund the relayer
    await refused(checkProviderCall(call({ memo: buildMemo("ETH.ETH", DEST_BTC, LIMIT, ESCROW) }), e, { inbound: inbound() }), /memo asset/);
    await refused(checkProviderCall(call({ memo: `${buildMemo(thorAsset(BTC), DEST_BTC, LIMIT, ESCROW)}/3/0:aff:50` }), e, { inbound: inbound() }), /memo/);
    await refused(checkProviderCall(call({ amount: NET / 2n }), e, { inbound: inbound() }), /amount/);
    await refused(checkProviderCall(call({ value: NET / 2n }), e, { inbound: inbound() }), /value/);
    await refused(checkProviderCall(call({ expiry: BigInt(NOW - 1) }), e, { inbound: inbound() }), /expiry/);
  });
  it("a zero limit is read as a zero minimum, which the approval check refuses", async () => {
    const c = await checkProviderCall(call({ memo: buildMemo(thorAsset(BTC), DEST_BTC, 0n, ESCROW) }), expectation(), { inbound: inbound() });
    expect(c.minOut).toBe(0n);
    expect(() => checkMinimum(c, LIMIT)).toThrow(MinimumMoved);
  });
});

describe("THORNode gateways queried by the wallet: all that answer must agree, a quorum must answer", () => {
  const entry = (address: string, router = PINNED.thorchainRouter) => [{ chain: "BTC", address: "bc1qvault", router: "" }, { chain: "ETH", address, router, halted: false }];
  const gateways = ["https://g1", "https://g2", "https://g3"];
  const fetchFrom = (answers: Record<string, unknown>, seen: { url: string; init: RequestInit }[] = []) => (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const base = url.slice(0, url.indexOf("/thorchain"));
    if (!(base in answers)) throw new TypeError("network error");
    return new Response(JSON.stringify(answers[base]), { status: 200 });
  }) as unknown as typeof fetch;
  const V = "0x755e7849e47cbbfaf0efe8c76a2def21dd4a85bb";

  it("three agreeing gateways confirm the vault; the request carries no cookie, referrer or order data", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const v = await thornodeInbound("ETH", { gateways, fetchFn: fetchFrom(Object.fromEntries(gateways.map((g) => [g, entry(V)])), seen) });
    expect(v.address).toBe(getAddress(V));
    expect(v.agreeing).toEqual(gateways);
    for (const s of seen) {
      expect(s.url).toMatch(/\/thorchain\/inbound_addresses$/);
      expect(s.init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
      expect(Object.keys(s.init.headers as Record<string, string>)).toEqual(["accept"]);
    }
  });
  it("one gateway naming another vault fails closed; so does a single answering gateway", async () => {
    await expect(thornodeInbound("ETH", { gateways, fetchFn: fetchFrom({ "https://g1": entry(V), "https://g2": entry(V), "https://g3": entry(ATTACKER) }) })).rejects.toThrow(/disagree/);
    await expect(thornodeInbound("ETH", { gateways, fetchFn: fetchFrom({ "https://g1": entry(V) }) })).rejects.toThrow(/only 1 of 3/);
    await expect(thornodeInbound("ETH", { gateways, fetchFn: fetchFrom({ "https://g1": entry(V), "https://g2": entry(V) }) })).resolves.toMatchObject({ agreeing: ["https://g1", "https://g2"] });
  });
});

// ---- Chainflip ---------------------------------------------------------------------------------------
describe("Chainflip: vault pinned, the vault swap pays the fresh address, fill-or-kill refunds the escrow", () => {
  // emitted by Chainflip's public backend on 2026-10-06: 1 ETH -> BTC to bc1qar0…, refund 0x2b8D…, retry 100 blocks
  const BACKEND_CALLDATA = "0xdd68734500000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000002a62633171617230737272723778666b7679356c3634336c79646e77397265353967747a7a7766356d647100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006001640000002b8dc27605bf11214247ae11a013fcadf2c1cb6500000000e022ce2f9fc6600300000000000000000000000000000000000000000000000070d0cd75a367987344a3896a18e1510e5429ca5e88357b6c2a2e306b3877380d000000" as Hex;
  const CF_ABI = parseAbi(["function xSwapNative(uint32 dstChain, bytes dstAddress, uint32 dstToken, bytes cfParameters) payable", "function xSwapToken(uint32 dstChain, bytes dstAddress, uint32 dstToken, address srcToken, uint256 amount, bytes cfParameters)"]);
  const le = (v: bigint, n: number) => Array.from({ length: n }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));
  const cfParams = (o: { refund?: string; minPrice?: bigint; retry?: number; boost?: number; brokerBps?: number; dca?: boolean; affiliates?: number; trailing?: boolean } = {}): Hex => {
    const b = [1, ...le(BigInt(o.retry ?? 100), 4), ...Array.from(Buffer.from((o.refund ?? ESCROW).slice(2), "hex")), ...le(o.minPrice ?? 1045449873187684626970181632n, 32), 0, 0,
      ...(o.dca ? [1, ...le(4n, 4), ...le(2n, 4)] : [0]), o.boost ?? 0, ...new Array(32).fill(0x70), ...le(BigInt(o.brokerBps ?? 0), 2), o.affiliates ?? 0, ...(o.trailing ? [0] : [])];
    return ("0x" + Buffer.from(b).toString("hex")) as Hex;
  };
  const native = (o: { chain?: number; dest?: string; token?: number; cf?: Hex; value?: bigint } = {}) => ({
    provider: PINNED.chainflipVault, value: o.value ?? NET,
    calldata: encodeFunctionData({ abi: CF_ABI, functionName: "xSwapNative", args: [o.chain ?? 3, ("0x" + Buffer.from(o.dest ?? DEST_BTC, "utf8").toString("hex")) as Hex, o.token ?? 5, o.cf ?? cfParams()] }),
  });

  it("the backend's own calldata passes, with the minimum the service derives from the same min price", async () => {
    const c = await checkProviderCall({ provider: PINNED.chainflipVault, value: NET, calldata: BACKEND_CALLDATA }, expectation());
    const cf = decodeVaultSwapCalldata(BACKEND_CALLDATA).cf; // the swap service's decoder
    expect(c).toMatchObject({ provider: "chainflip", receiver: DEST_BTC, minOut: minOutFromPrice(NET, cf.minPriceX128), refundTo: "escrow" });
    expect(c.minOut).toBe(3072301n); // sats, as services/private-swap/test/chainflip-unit.test.ts
    expect(decodeCfParameters(Buffer.from(cfParams().slice(2), "hex")).minPriceX128).toBe(cf.minPriceX128);
  });
  it("an ERC-20 order is an xSwapToken of exactly the net amount with no ETH", async () => {
    const e = expectation({ from: USDC, net: 1_000_000_000n });
    const tok = (src: string, amount: bigint, value = 0n) => ({ provider: PINNED.chainflipVault, value, calldata: encodeFunctionData({ abi: CF_ABI, functionName: "xSwapToken", args: [3, ("0x" + Buffer.from(DEST_BTC).toString("hex")) as Hex, 5, src as Address, amount, cfParams()] }) });
    await expect(checkProviderCall(tok(USDC.asset, 1_000_000_000n), e)).resolves.toMatchObject({ provider: "chainflip" });
    await refused(checkProviderCall(tok(ATTACKER, 1_000_000_000n), e), /asset/);
    await refused(checkProviderCall(tok(USDC.asset, 999n), e), /amount/);
    await refused(checkProviderCall(tok(USDC.asset, 1_000_000_000n, 1n), e), /amount/);
  });
  it("refuses: another chain, asset or address; a refund elsewhere; broker fee, boost, DCA, affiliates, trailing bytes; a long retry", async () => {
    const e = expectation();
    await refused(checkProviderCall(native({ chain: 1 }), e), /chain/);
    await refused(checkProviderCall(native({ token: 1 }), e), /asset/);
    await refused(checkProviderCall(native({ dest: "bc1qattacker" }), e), /receiver/);
    await refused(checkProviderCall(native({ cf: cfParams({ refund: ATTACKER }) }), e), /refund/);
    await refused(checkProviderCall(native({ cf: cfParams({ brokerBps: 50 }) }), e), /fees/);
    await refused(checkProviderCall(native({ cf: cfParams({ boost: 5 }) }), e), /fees/);
    await refused(checkProviderCall(native({ cf: cfParams({ dca: true }) }), e), /fees/);
    await refused(checkProviderCall(native({ cf: cfParams({ affiliates: 1 }) }), e), /affiliate/);
    await refused(checkProviderCall(native({ cf: cfParams({ trailing: true }) }), e), /trailing/);
    await refused(checkProviderCall(native({ cf: cfParams({ retry: 100_000 }) }), e), /retry/);
    await refused(checkProviderCall(native({ value: NET / 2n }), e), /value/);
  });
  it("a zeroed min price reads as a zero minimum", async () => {
    const c = await checkProviderCall(native({ cf: cfParams({ minPrice: 0n }) }), expectation());
    expect(c.minOut).toBe(0n);
    expect(() => checkMinimum(c, 1n)).toThrow(MinimumMoved);
  });
});

// ---- Across (direct) ---------------------------------------------------------------------------------
describe("Across: SpokePool pinned, exact fill to the fresh address, unfilled deposits refund the escrow", () => {
  const OUT = 997_000_000_000_000_000n;
  const dep = (o: Partial<Parameters<typeof encodeDepositV3>[0]> = {}, value = NET) => ({
    provider: PINNED.acrossSpokePool, value,
    calldata: encodeDepositV3({ depositor: ESCROW, recipient: DEST_EVM, inputToken: ENGINE_WETH.ethereum, outputToken: ENGINE_WETH.base, inputAmount: NET, outputAmount: OUT, destinationChainId: 8453, exclusiveRelayer: ZERO, quoteTimestamp: NOW - 10, fillDeadline: NOW + 3600, exclusivityDeadline: 0, ...o }) as Hex,
  });
  const e = expectation({ to: ETH_BASE, destination: DEST_EVM });
  it("the engine's deposit passes: minimum = the exact output amount", async () => {
    await expect(checkProviderCall(dep(), e)).resolves.toMatchObject({ provider: "across", receiver: DEST_EVM, minOut: OUT, refundTo: "escrow" });
  });
  it("refuses: another recipient, depositor, token, chain, amount; a message; an expired fill deadline", async () => {
    await refused(checkProviderCall(dep({ recipient: ATTACKER }), e), /receiver/);
    await refused(checkProviderCall(dep({ depositor: ATTACKER }), e), /refund/);
    await refused(checkProviderCall(dep({ outputToken: USDC_BASE.asset }), e), /asset/);
    await refused(checkProviderCall(dep({ inputToken: USDC.asset }), e), /asset/);
    await refused(checkProviderCall(dep({ destinationChainId: 42161 }), e), /chain/);
    await refused(checkProviderCall(dep({ inputAmount: NET / 2n }), e), /amount/);
    await refused(checkProviderCall(dep({ fillDeadline: NOW - 1 }), e), /deadline/);
    const withMessage = encodeCall("depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)", [
      { t: "address", v: ESCROW }, { t: "address", v: DEST_EVM }, { t: "address", v: ENGINE_WETH.ethereum }, { t: "address", v: ENGINE_WETH.base }, { t: "uint", v: NET }, { t: "uint", v: OUT }, { t: "uint", v: 8453 }, { t: "address", v: ZERO }, { t: "uint", v: NOW }, { t: "uint", v: NOW + 3600 }, { t: "uint", v: 0 }, { t: "bytes", v: "0xdeadbeef" },
    ]);
    await refused(checkProviderCall({ provider: PINNED.acrossSpokePool, value: NET, calldata: withMessage as Hex }, e), /message/);
  });
});

// ---- Mayan (direct: forwarder + Fast-MCTP) -----------------------------------------------------------
describe("Mayan: forwarder and Fast-MCTP pinned, the order pays the fresh address, unfilled orders refund at the destination", () => {
  const MIN_UNITS = 2_233_444_849n; // 22.33444849 SOL in 8 decimals
  const payload = (o: { dest?: Buffer; tokenOut?: Buffer; min?: bigint; referrer?: Buffer; referrerBps?: number; deadline?: bigint } = {}) => ({
    destAddr: o.dest ?? addressHex32("solana", DEST_SOL), tokenOut: o.tokenOut ?? Buffer.alloc(32), amountOutMin: o.min ?? MIN_UNITS, gasDrop: 0n, redeemFee: 210_000n, refundFee: 150_000n,
    deadline: o.deadline ?? BigInt(NOW + 3600), referrerAddr: o.referrer ?? Buffer.alloc(32), referrerBps: o.referrerBps ?? 0,
  });
  const order = (p = payload(), tokenIn: string = USDC.asset, amountIn = NET, domain = 5) => encodeCreateOrder(tokenIn, amountIn, 1000n, domain, 1000, p);
  const ethCall = (o: { amountIn?: bigint; middle?: string; minMiddle?: bigint; protocol?: string; data?: Hex; value?: bigint } = {}) => ({
    provider: PINNED.mayanForwarder, value: o.value ?? NET,
    calldata: encodeCall("swapAndForwardEth(uint256,address,bytes,address,uint256,address,bytes)", [
      { t: "uint", v: o.amountIn ?? NET }, { t: "address", v: "0x0000000000000000000000000000000000000e77" }, { t: "bytes", v: "0x1234" }, { t: "address", v: o.middle ?? USDC.asset },
      { t: "uint", v: o.minMiddle ?? 2_500_000_000n }, { t: "address", v: o.protocol ?? MAYAN_FAST_MCTP }, { t: "bytes", v: o.data ?? order() },
    ]) as Hex,
  });
  const e = expectation({ to: SOL, destination: DEST_SOL });
  it("the engine's ETH-source call passes: minimum = amountOutMin scaled to SOL's 9 decimals; refunds land at the destination", async () => {
    await expect(checkProviderCall(ethCall(), e)).resolves.toMatchObject({ provider: "mayan", receiver: DEST_SOL, minOut: MIN_UNITS * 10n, refundTo: "destination" });
  });
  it("a USDC-source call forwards exactly the net amount, without a permit", async () => {
    const eu = expectation({ from: USDC, to: SOL, destination: DEST_SOL, net: 1_000_000_000n });
    const erc = (amountIn: bigint, orderAmount: bigint, permitValue = 0n) => ({
      provider: PINNED.mayanForwarder, value: 0n,
      calldata: encodeCall("forwardERC20(address,uint256,(uint256,uint256,uint8,bytes32,bytes32),address,bytes)", [
        { t: "address", v: USDC.asset }, { t: "uint", v: amountIn }, { t: "uint", v: permitValue }, { t: "uint", v: 0 }, { t: "uint", v: 0 }, { t: "bytes32", v: Buffer.alloc(32) }, { t: "bytes32", v: Buffer.alloc(32) },
        { t: "address", v: MAYAN_FAST_MCTP }, { t: "bytes", v: order(payload(), USDC.asset, orderAmount) },
      ]) as Hex,
    });
    await expect(checkProviderCall(erc(1_000_000_000n, 1_000_000_000n), eu)).resolves.toMatchObject({ provider: "mayan" });
    await refused(checkProviderCall(erc(1_000_000_000n, 999_000_000n), eu), /order/);
    await refused(checkProviderCall(erc(999_000_000n, 999_000_000n), eu), /amount/);
    await refused(checkProviderCall(erc(1_000_000_000n, 1_000_000_000n, 1n), eu), /permit/);
  });
  it("refuses: another receiver, token out, CCTP domain, referrer, protocol contract, middle token; an expired order", async () => {
    await refused(checkProviderCall(ethCall({ data: order(payload({ dest: addressHex32("solana", "11111111111111111111111111111112") })) }), e), /receiver/);
    await refused(checkProviderCall(ethCall({ data: order(payload({ tokenOut: addressHex32("ethereum", USDC.asset) })) }), e), /asset/);
    await refused(checkProviderCall(ethCall({ data: order(payload(), USDC.asset, NET, 6) }), e), /chain/);
    await refused(checkProviderCall(ethCall({ data: order(payload({ referrer: addressHex32("ethereum", ATTACKER), referrerBps: 50 })) }), e), /fees/);
    await refused(checkProviderCall(ethCall({ protocol: ATTACKER }), e), /protocol/);
    await refused(checkProviderCall(ethCall({ middle: ENGINE_WETH.ethereum }), e), /swap/);
    await refused(checkProviderCall(ethCall({ minMiddle: 0n }), e), /swap/);
    await refused(checkProviderCall(ethCall({ data: order(payload({ deadline: BigInt(NOW - 1) })) }), e), /deadline/);
    await refused(checkProviderCall(ethCall({ amountIn: NET / 2n }), e), /amount/);
  });
  it("a malformed destination is a mismatch, not a crash", async () => {
    await refused(checkProviderCall(ethCall(), { ...e, destination: "not-base58-0OIl" }), /call/);
  });
});

// ---- LI.FI (diamond: AcrossFacetV4 and MayanFacet) ---------------------------------------------------
const STRUCTS = [
  "struct BridgeData { bytes32 transactionId; string bridge; string integrator; address referrer; address sendingAssetId; address receiver; uint256 minAmount; uint256 destinationChainId; bool hasSourceSwaps; bool hasDestinationCall; }",
  "struct SwapData { address callTo; address approveTo; address sendingAssetId; address receivingAssetId; uint256 fromAmount; bytes callData; bool requiresDeposit; }",
  "struct AcrossV4Data { bytes32 receiverAddress; bytes32 refundAddress; bytes32 sendingAssetId; bytes32 receivingAssetId; uint256 outputAmount; uint128 outputAmountMultiplier; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }",
  "struct MayanData { bytes32 nonEVMReceiver; address mayanProtocol; bytes protocolData; address swapProtocol; bytes swapData; address middleToken; uint256 minMiddleAmount; address refundRecipient; uint256 mayanAmountIn; }",
] as const;
const LIFI = {
  startAcross: "function startBridgeTokensViaAcrossV4((bytes32,string,string,address,address,address,uint256,uint256,bool,bool),(bytes32,bytes32,bytes32,bytes32,uint256,uint128,bytes32,uint32,uint32,uint32,bytes))",
  swapAcross: "function swapAndStartBridgeTokensViaAcrossV4((bytes32,string,string,address,address,address,uint256,uint256,bool,bool),(address,address,address,address,uint256,bytes,bool)[],(bytes32,bytes32,bytes32,bytes32,uint256,uint128,bytes32,uint32,uint32,uint32,bytes))",
  startMayan: "function startBridgeTokensViaMayan((bytes32,string,string,address,address,address,uint256,uint256,bool,bool),(bytes32,address,bytes,address,bytes,address,uint256,address,uint256))",
  swapMayan: "function swapAndStartBridgeTokensViaMayan((bytes32,string,string,address,address,address,uint256,uint256,bool,bool),(address,address,address,address,uint256,bytes,bool)[],(bytes32,address,bytes,address,bytes,address,uint256,address,uint256))",
};
const LIFI_ABI = parseAbi([...STRUCTS,
  "function swapAndStartBridgeTokensViaAcrossV4(BridgeData _bridgeData, SwapData[] _swapData, AcrossV4Data _acrossData) payable",
  "function swapAndStartBridgeTokensViaMayan(BridgeData _bridgeData, SwapData[] _swapData, MayanData _mayanData) payable",
]);

describe("LI.FI: diamond pinned, facets read by selector; Across's minimum is what the facet hands Across", () => {
  const MIN_AMOUNT = 997_500_000_000_000_000n; // after LI.FI's fee collection (the "source swap")
  const MULT = 999_919_366_746_357_896n;
  const FLOOR = (MIN_AMOUNT * MULT) / 10n ** 18n;
  const bridgeData = (o: Record<string, unknown> = {}) => ({ transactionId: padHex("0x01", { size: 32 }), bridge: "across", integrator: "lifi-api", referrer: ZERO, sendingAssetId: ZERO, receiver: DEST_EVM, minAmount: MIN_AMOUNT, destinationChainId: 8453n, hasSourceSwaps: true, hasDestinationCall: false, ...o });
  const feeSwap = (o: Record<string, unknown> = {}) => [{ callTo: "0x00000000000000000000000000000000000fee00" as Address, approveTo: "0x00000000000000000000000000000000000fee00" as Address, sendingAssetId: ZERO, receivingAssetId: ZERO, fromAmount: NET, callData: "0x" as Hex, requiresDeposit: true, ...o }];
  const acrossData = (o: Record<string, unknown> = {}) => ({ receiverAddress: bytes32Of("base", DEST_EVM), refundAddress: bytes32Of("ethereum", ESCROW), sendingAssetId: bytes32Of("ethereum", ENGINE_WETH.ethereum), receivingAssetId: bytes32Of("base", ENGINE_WETH.base), outputAmount: FLOOR, outputAmountMultiplier: MULT, exclusiveRelayer: padHex("0x", { size: 32 }), quoteTimestamp: NOW - 10, fillDeadline: NOW + 3600, exclusivityParameter: 0, message: "0x" as Hex, ...o });
  const acrossCall = (bd = bridgeData(), sw = feeSwap(), ad = acrossData(), value = NET) => ({ provider: PINNED.lifiDiamond, value, calldata: encodeFunctionData({ abi: LIFI_ABI, functionName: "swapAndStartBridgeTokensViaAcrossV4", args: [bd as any, sw as any, ad as any] }) });
  const e = expectation({ to: ETH_BASE, destination: DEST_EVM });
  // the swap service's verifier on the same call: both must agree
  const serviceVerify = (calldata: Hex, toAmountMin: bigint) => verifyLifiTransaction(
    { from: ETH as any, to: ETH_BASE as any, amount: NET, destination: DEST_EVM, source: ESCROW, slippageBps: 50 },
    { tool: "across", transactionRequest: { to: LIFI_DIAMOND.ethereum, data: calldata, value: "0x" + NET.toString(16), chainId: 1 }, action: { fromAddress: ESCROW, toAddress: DEST_EVM, fromChainId: 1, toChainId: 8453 }, estimate: { toAmountMin: toAmountMin.toString() } },
  );

  it("the swap variant passes: minimum = minAmount × multiplier / 1e18, and the swap service agrees", async () => {
    const call = acrossCall();
    const c = await checkProviderCall(call, e);
    expect(c).toMatchObject({ provider: "lifi", receiver: DEST_EVM, minOut: FLOOR, refundTo: "escrow" });
    expect(serviceVerify(call.calldata, FLOOR).verified).toContain("min-out");
  });
  it("a multiplier of 1 under an untouched outputAmount is refused by both; a consistent tiny output reads as the tiny minimum it is", async () => {
    const lowMult = acrossCall(undefined, undefined, acrossData({ outputAmountMultiplier: 1n }));
    await refused(checkProviderCall(lowMult, e), /minimum/);
    expect(() => serviceVerify(lowMult.calldata, FLOOR)).toThrow(/outputAmountMultiplier/);
    const tiny = acrossCall(undefined, undefined, acrossData({ outputAmountMultiplier: 1n, outputAmount: 0n }));
    const c = await checkProviderCall(tiny, e);
    expect(c.minOut).toBe(0n);
    expect(() => checkMinimum(c, FLOOR)).toThrow(MinimumMoved);
  });
  it("refuses: another receiver (either field), refund address, delivered asset, chain; a destination call; another spend or value", async () => {
    await refused(checkProviderCall(acrossCall(undefined, undefined, acrossData({ receiverAddress: bytes32Of("base", ATTACKER) })), e), /receiver/);
    await refused(checkProviderCall(acrossCall(bridgeData({ receiver: ATTACKER })), e), /receiver/);
    await refused(checkProviderCall(acrossCall(undefined, undefined, acrossData({ refundAddress: bytes32Of("ethereum", ATTACKER) })), e), /refund/);
    await refused(checkProviderCall(acrossCall(undefined, undefined, acrossData({ receivingAssetId: bytes32Of("base", USDC_BASE.asset) })), e), /asset/);
    await refused(checkProviderCall(acrossCall(bridgeData({ destinationChainId: 42161n })), e), /chain/);
    await refused(checkProviderCall(acrossCall(bridgeData({ hasDestinationCall: true })), e), /receiver/);
    await refused(checkProviderCall(acrossCall(undefined, feeSwap({ fromAmount: NET / 2n })), e), /amount/);
    await refused(checkProviderCall(acrossCall(undefined, undefined, undefined, NET * 2n), e), /value/);
  });
  it("a source swap into a token the escrow cannot re-shield is refused by both: an unfilled deposit would strand it there (PP-S08)", async () => {
    // ETH -> USDC on Base the LI.FI way: swap ETH into USDC on Ethereum, bridge USDC. Across refunds an unfilled deposit
    // to its depositor (the escrow) in USDC, and an ETH order's escrow re-shields only ETH (and unwrapped WETH)
    const intoUsdc = acrossCall(bridgeData({ sendingAssetId: USDC.asset }), feeSwap({ receivingAssetId: USDC.asset }), acrossData({ sendingAssetId: bytes32Of("ethereum", USDC.asset), receivingAssetId: bytes32Of("base", USDC_BASE.asset) }));
    await refused(checkProviderCall(intoUsdc, expectation({ to: USDC_BASE, destination: DEST_EVM })), /refund/);
    expect(() => verifyLifiTransaction(
      { from: ETH as any, to: USDC_BASE as any, amount: NET, destination: DEST_EVM, source: ESCROW, slippageBps: 50 },
      { tool: "across", transactionRequest: { to: LIFI_DIAMOND.ethereum, data: intoUsdc.calldata, value: "0x" + NET.toString(16), chainId: 1 }, action: { fromAddress: ESCROW, toAddress: DEST_EVM, fromChainId: 1, toChainId: 8453 }, estimate: { toAmountMin: "1" } },
    )).toThrow(/cannot re-shield/);
    // into WETH it passes: refund() unwraps it before re-shielding
    const intoWeth = acrossCall(bridgeData({ sendingAssetId: ENGINE_WETH.ethereum }), feeSwap({ receivingAssetId: ENGINE_WETH.ethereum }));
    await expect(checkProviderCall(intoWeth, e)).resolves.toMatchObject({ refundTo: "escrow", minOut: FLOOR });
    expect(serviceVerify(intoWeth.calldata, FLOOR).verified).toContain("refunds re-shieldable");
  });

  const SOL32 = bytes32Of("solana", DEST_SOL);
  const mayanData = (o: Record<string, unknown> = {}) => ({ nonEVMReceiver: SOL32, mayanProtocol: "0x40ffe85a28dc9993541449464d7529a922142960" as Address, protocolData: "0x1234" as Hex, swapProtocol: "0x529863940bf6065d8c122a550c2ff37c1cfefa16" as Address, swapData: "0x" as Hex, middleToken: ENGINE_WETH.ethereum as Address, minMiddleAmount: 1n, refundRecipient: ESCROW, mayanAmountIn: MIN_AMOUNT, ...o });
  const mayanCall = (md = mayanData(), bd = bridgeData({ bridge: "mayan", receiver: "0x11f111f111f111f111f111f111f111f111f111f1", destinationChainId: 1151111081099710n })) => ({ provider: PINNED.lifiDiamond, value: NET, calldata: encodeFunctionData({ abi: LIFI_ABI, functionName: "swapAndStartBridgeTokensViaMayan", args: [bd as any, feeSwap() as any, md as any] }) });
  const es = expectation({ to: SOL, destination: DEST_SOL });
  it("Mayan facet: accepted only under Fastest (its minimum is inside Mayan's order); its sweep goes to the escrow", async () => {
    await refused(checkProviderCall(mayanCall(), es), /minimum/);
    const c = await checkProviderCall(mayanCall(), { ...es, policy: "fastest" });
    expect(c).toMatchObject({ provider: "lifi", minOut: null, receiver: DEST_SOL });
    expect(c.facts.join(" ")).toMatch(/not readable/);
  });
  it("Mayan facet: refuses another non-EVM receiver, a sweep to someone else, a smaller mayanAmountIn", async () => {
    const f = { ...es, policy: "fastest" as const };
    await refused(checkProviderCall(mayanCall(mayanData({ nonEVMReceiver: bytes32Of("solana", "11111111111111111111111111111112") })), f), /receiver/);
    await refused(checkProviderCall(mayanCall(mayanData({ refundRecipient: ATTACKER })), f), /refund/);
    await refused(checkProviderCall(mayanCall(mayanData({ mayanAmountIn: 1n })), f), /amount/);
  });
  it("any other facet is a call this wallet cannot read", async () => {
    const other = acrossCall();
    await refused(checkProviderCall({ ...other, calldata: ("0x4c279d6b" + other.calldata.slice(10)) as Hex }, e), /not an entry point this wallet can read/);
  });
});

describe("dispatch: only pinned provider contracts; deposit addresses are a promise the wallet cannot read", () => {
  it("refuses an unknown contract, a plain ETH deposit, a token transfer to a deposit address, a non-Ethereum escrow", async () => {
    await refused(checkProviderCall({ provider: ATTACKER, value: NET, calldata: "0x1234" }, expectation()), /not a provider contract/);
    await refused(checkProviderCall({ provider: ATTACKER, value: NET, calldata: "0x" }, expectation()), /deposit address/);
    const transfer = encodeFunctionData({ abi: parseAbi(["function transfer(address to, uint256 amount)"]), functionName: "transfer", args: [ATTACKER, 1_000_000_000n] });
    await refused(checkProviderCall({ provider: getAddress(USDC.asset), value: 0n, calldata: transfer }, expectation({ from: USDC, net: 1_000_000_000n })), /deposit address/);
    await refused(checkProviderCall({ provider: PINNED.chainflipVault, value: NET, calldata: "0x" }, expectation({ from: { ...ETH, chain: "base" } })), /Ethereum/);
    // a testnet deployment: the pinned addresses hold no contract there, so nothing is signed
    await refused(checkProviderCall({ provider: PINNED.chainflipVault, value: NET, calldata: "0x" }, expectation({ chainId: 11155111n })), /chain 11155111/);
  });
});
