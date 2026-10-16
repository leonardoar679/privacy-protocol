// The wallet's own check of the provider call the one-time order key signs (packages/sdk/src/providerCall.ts).
// Honest calls are built with the swap service's OWN encoders (packages/swap-engine adapters), so the
// two independent implementations must agree; then every way a dishonest service could bend a call —
// another receiver, a refund that does not come back, another asset or amount, fees, a lowered
// minimum, a facet or contract the wallet cannot read — is refused, and a lowered minimum is reported
// against what the user approved. Chainflip's honest call is the one its public backend emitted
// (packages/swap-engine/test/chainflip-unit.test.ts). Offline: THORNode answers are stubbed.
import { describe, it, expect } from "vitest";
import { encodeAbiParameters, encodeFunctionData, getAddress, padHex, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import { ACROSS_DESTINATION, PINNED, ProviderCallMismatch, ProviderCallUnverified, MinimumMoved, bytes32Of, checkMinimum, checkProviderCall, decodeCfParameters, thorAsset, thornodeActiveVault, thornodeInbound, type ActiveVaultLookup, type CallExpectation, type InboundLookup } from "@privacy-wallet/sdk/providerCall";
import { buildMemo, encodeDepositWithExpiry, thorAsset as engineThorAsset } from "@privacy-wallet/swap-engine/adapters/thorchain";
import { CF_ASSET_ID, CF_CHAIN_ID, CHAINFLIP_VAULT_ETHEREUM, SEL_X_SWAP_NATIVE, SEL_X_SWAP_TOKEN, decodeVaultSwapCalldata, minOutFromPrice } from "@privacy-wallet/swap-engine/adapters/chainflip";
import { SPOKE_POOL, WETH as ENGINE_WETH, encodeDepositV3 } from "@privacy-wallet/swap-engine/adapters/across";
import { MAYAN_ETH_WRAPPER, MAYAN_FAST_MCTP, MAYAN_FORWARDER, MAYAN_SWIFT_V2, SEL_CREATE_ORDER, SEL_FORWARD_ERC20, SEL_SWAP_AND_FORWARD_ETH, SEL_WRAP, WETH_ETHEREUM, addressHex32, encodeCreateOrder, encodeSwiftCreateOrder, type SwiftOrder } from "@privacy-wallet/swap-engine/adapters/mayan";
import { LIFI_DIAMOND, SEL_ACROSS_V4, SEL_ACROSS_V4_SWAP, SEL_MAYAN, SEL_MAYAN_SWAP, verifyLifiTransaction } from "@privacy-wallet/swap-engine/adapters/lifi";
import { ACROSS_EVENT_EMITTER, ACROSS_MULTICALL_HANDLER, ACROSS_PERIPHERY, SEL_SWAP_AND_BRIDGE, acrossSwapPins, verifyAcrossSwapCall } from "@privacy-wallet/swap-engine/adapters/acrossSwap";
import { encodeCall } from "@privacy-wallet/swap-engine/abi";
import type { AssetRef } from "@privacy-wallet/sdk/swapService";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ESCROW = getAddress("0x2b8dc27605bf11214247ae11a013fcadf2c1cb65");
const ATTACKER = getAddress("0x000000000000000000000000000000000000bad1");
const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const USDC: AssetRef = { chain: "ethereum", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" };
const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const SOL: AssetRef = { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" };
const ETH_BASE: AssetRef = { chain: "base", asset: "native", decimals: 18, symbol: "ETH" };
const USDC_BASE: AssetRef = { chain: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" };
/** the pool's USDC vault, as the deployment names it (VITE_ERC20_VAULTS) */
const POOL_USDC = [{ token: USDC.asset, symbol: USDC.symbol, decimals: USDC.decimals }];
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
    expect(PINNED.mayanSwiftV2.toLowerCase()).toBe(MAYAN_SWIFT_V2);
    expect(PINNED.mayanEthWrapper.toLowerCase()).toBe(MAYAN_ETH_WRAPPER);
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
  /** the gateways' lists of THORChain's active vaults: a vault they list is confirmed, any other refused */
  const listed = (vaults: string[]): ActiveVaultLookup => async (_chain, v) => {
    if (!vaults.some((x) => x.toLowerCase() === v.toLowerCase())) throw new ProviderCallMismatch("thorchain", "vault", `${v} is not an active THORChain ETH vault on 3 of the 3 THORNode gateways that answered`);
    return { confirmedBy: ["a", "b", "c"] };
  };
  const OTHER_VAULT = getAddress("0x46f3fb8c14006268d153b18000495c8ee858e94b");
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
  it("THORChain moved its inbound vault since the call was prepared: another of its active vaults passes, and says so (2026-10-14)", async () => {
    // the local stack's run of 2026-10-14 stopped a funded swap here: the call named 0x718f…, the gateways suggested 0x46F3…
    // a few seconds later — both active THORChain vaults
    const c = await checkProviderCall(call(), expectation(), { inbound: inbound({ address: OTHER_VAULT }), active: listed([VAULT, OTHER_VAULT]) });
    expect(c).toMatchObject({ provider: "thorchain", minOut: LIMIT });
    expect(c.facts[0]).toBe("router pinned; an active THORChain vault, listed by the 3 THORNode gateways that answered");
    // the gateways differ on the suggestion (one a block behind): the call's vault is looked up the same way
    await expect(checkProviderCall(call(), expectation(), { inbound: inbound({ address: "" }), active: listed([VAULT]) })).resolves.toMatchObject({ minOut: LIMIT });
    // the suggested vault needs no list
    const never: ActiveVaultLookup = async () => {
      throw new Error("not asked");
    };
    expect((await checkProviderCall(call(), expectation(), { inbound: inbound(), active: never })).facts[0]).toBe("router pinned; inbound vault confirmed by 3 THORNode gateways");
  });
  it("gateways that do not answer are an outage, never a mismatch: the check passes it through for the runner to try again", async () => {
    const outage = new ProviderCallUnverified("thorchain", "only 1 of 3 THORNode gateways answered for ETH; 2 must agree");
    const down: InboundLookup = async () => {
      throw outage;
    };
    await expect(checkProviderCall(call(), expectation(), { inbound: down })).rejects.toBe(outage);
    await expect(
      checkProviderCall(call(), expectation(), {
        inbound: inbound({ address: OTHER_VAULT }),
        active: async () => {
          throw outage;
        },
      }),
    ).rejects.toBe(outage);
    // any other failure inside the check is still a mismatch: nothing is signed
    await refused(checkProviderCall(call(), expectation(), { inbound: async () => Promise.reject(new Error("boom")) }), /call/);
  });
  it("an ERC-20 order deposits the token and forwards no ETH", async () => {
    const e = expectation({ from: USDC, net: 1_000_000_000n });
    await expect(checkProviderCall(call({ asset: USDC.asset, amount: 1_000_000_000n, value: 0n }), e, { inbound: inbound() })).resolves.toMatchObject({ minOut: LIMIT });
    await refused(checkProviderCall(call({ asset: ZERO, amount: 1_000_000_000n, value: 0n }), e, { inbound: inbound() }), /asset/);
  });
  it("a halted inbound is THORChain's outage: nothing signed, tried again later — never a call that does something else (2026-10-14)", async () => {
    const p = checkProviderCall(call(), expectation(), { inbound: inbound({ halted: true }) });
    await expect(p).rejects.toBeInstanceOf(ProviderCallUnverified);
    await expect(p).rejects.toThrow(/halted Ethereum inbound/);
  });
  it("refuses: another vault or router; another receiver, refund, asset, limit form; another amount or value", async () => {
    const e = expectation();
    await refused(checkProviderCall(call({ vault: ATTACKER }), e, { inbound: inbound(), active: listed([VAULT, OTHER_VAULT]) }), /vault/);
    await refused(checkProviderCall(call(), e, { inbound: inbound({ router: ATTACKER }) }), /router/);
    await refused(checkProviderCall(call({ memo: buildMemo(thorAsset(BTC), "bc1qattacker", LIMIT, ESCROW) }), e, { inbound: inbound() }), /receiver/);
    await refused(checkProviderCall(call({ memo: buildMemo(thorAsset(BTC), DEST_BTC, LIMIT, ATTACKER) }), e, { inbound: inbound() }), /refund/);
    await refused(checkProviderCall(call({ memo: buildMemo(thorAsset(BTC), DEST_BTC, LIMIT) }), e, { inbound: inbound() }), /memo/); // no refund address: THORChain would refund the relayer
    await refused(checkProviderCall(call({ memo: buildMemo("ETH.ETH", DEST_BTC, LIMIT, ESCROW) }), e, { inbound: inbound() }), /memo asset/);
    await refused(checkProviderCall(call({ memo: `${buildMemo(thorAsset(BTC), DEST_BTC, LIMIT, ESCROW)}/3/5:aff:50` }), e, { inbound: inbound() }), /memo/);
    await refused(checkProviderCall(call({ amount: NET / 2n }), e, { inbound: inbound() }), /amount/);
  });
  it("a streamed memo (whale spec §12) passes with an explicit, bounded plan and says what the limit means; quantity 0 and absurd plans are refused", async () => {
    const e = expectation();
    const c = await checkProviderCall(call({ memo: buildMemo(thorAsset(BTC), DEST_BTC, LIMIT, ESCROW, { interval: 1, quantity: 205 }) }), e, { inbound: inbound() });
    expect(c.minOut).toBe(LIMIT);
    expect(c.facts.join(" ")).toMatch(/streams 205 sub-swaps, one every 1 block/);
    expect(c.facts.join(" ")).toMatch(/limit applies per sub-swap/);
    await refused(checkProviderCall(call({ memo: buildMemo(thorAsset(BTC), DEST_BTC, LIMIT, ESCROW, { interval: 1, quantity: 0 }) }), e, { inbound: inbound() }), /streaming/);
    await refused(checkProviderCall(call({ memo: buildMemo(thorAsset(BTC), DEST_BTC, LIMIT, ESCROW, { interval: 0, quantity: 5 }) }), e, { inbound: inbound() }), /streaming/);
    await refused(checkProviderCall(call({ memo: buildMemo(thorAsset(BTC), DEST_BTC, LIMIT, ESCROW, { interval: 1, quantity: 14_401 }) }), e, { inbound: inbound() }), /streaming/);
    await refused(checkProviderCall(call({ memo: buildMemo(thorAsset(BTC), DEST_BTC, LIMIT, ESCROW, { interval: 101, quantity: 5 }) }), e, { inbound: inbound() }), /streaming/);
    await refused(checkProviderCall(call({ value: NET / 2n }), e, { inbound: inbound() }), /value/);
    await refused(checkProviderCall(call({ expiry: BigInt(NOW - 1) }), e, { inbound: inbound() }), /expiry/);
  });
  it("a zero limit is read as a zero minimum, which the approval check refuses", async () => {
    const c = await checkProviderCall(call({ memo: buildMemo(thorAsset(BTC), DEST_BTC, 0n, ESCROW) }), expectation(), { inbound: inbound() });
    expect(c.minOut).toBe(0n);
    expect(() => checkMinimum(c, LIMIT)).toThrow(MinimumMoved);
  });
});

describe("THORNode gateways queried by the wallet: a quorum must answer, all that answer must agree on the router", () => {
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
  it("gateways naming different vaults confirm none (THORChain moving it: the call's vault is then looked up in their lists); another router fails closed; a single answering gateway is an outage", async () => {
    await expect(thornodeInbound("ETH", { gateways, fetchFn: fetchFrom({ "https://g1": entry(V), "https://g2": entry(V), "https://g3": entry(ATTACKER) }) })).resolves.toMatchObject({ address: "", agreeing: gateways });
    await expect(thornodeInbound("ETH", { gateways, fetchFn: fetchFrom({ "https://g1": entry(V), "https://g2": entry(V), "https://g3": entry(V, ATTACKER) }) })).rejects.toBeInstanceOf(ProviderCallMismatch);
    await expect(thornodeInbound("ETH", { gateways, fetchFn: fetchFrom({ "https://g1": entry(V), "https://g2": entry(V), "https://g3": entry(V, ATTACKER) }) })).rejects.toThrow(/disagree on the ETH router/);
    // halted on one gateway is halted
    const halted = [{ chain: "ETH", address: V, router: PINNED.thorchainRouter, halted: true }];
    await expect(thornodeInbound("ETH", { gateways, fetchFn: fetchFrom({ "https://g1": entry(V), "https://g2": entry(V), "https://g3": halted }) })).resolves.toMatchObject({ halted: true });
    // too few answers: nothing is signed, but it is tried again later (2026-10-14: it had stopped a funded swap as an unsafe call)
    await expect(thornodeInbound("ETH", { gateways, fetchFn: fetchFrom({ "https://g1": entry(V) }) })).rejects.toBeInstanceOf(ProviderCallUnverified);
    await expect(thornodeInbound("ETH", { gateways, fetchFn: fetchFrom({ "https://g1": entry(V) }) })).rejects.toThrow(/only 1 of 3/);
    await expect(thornodeInbound("ETH", { gateways, fetchFn: fetchFrom({ "https://g1": entry(V), "https://g2": entry(V) }) })).resolves.toMatchObject({ agreeing: ["https://g1", "https://g2"] });
  });
});

describe("THORChain's active vaults, as the gateways list them (2026-10-14: its inbound vault moves between them several times an hour)", () => {
  const gateways = ["https://g1", "https://g2", "https://g3"];
  const V = "0x718f6c9df785bc4e323086de024ca822efbe8ab9";
  const W = "0x46f3fb8c14006268d153b18000495c8ee858e94b";
  const RETIRING = "0x587c7c3ba9e47b1afd9da9a79c127ade753ac53a";
  const asgard = (...active: string[]) => [
    ...active.map((address) => ({ status: "ActiveVault", addresses: [{ chain: "BTC", address: "bc1qvault" }, { chain: "ETH", address }] })),
    { status: "RetiringVault", addresses: [{ chain: "ETH", address: RETIRING }] },
  ];
  const fetchFrom = (answers: Record<string, unknown>, seen: { url: string; init: RequestInit }[] = []) => (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const base = url.slice(0, url.indexOf("/thorchain"));
    if (!(base in answers)) throw new TypeError("network error");
    return new Response(JSON.stringify(answers[base]), { status: 200 });
  }) as unknown as typeof fetch;
  const all = (...active: string[]) => Object.fromEntries(gateways.map((g) => [g, asgard(...active)]));

  it("a vault every answering gateway lists as active is confirmed (any case); the request is the same for every user", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    await expect(thornodeActiveVault("ETH", getAddress(W), { gateways, fetchFn: fetchFrom(all(V, W), seen) })).resolves.toEqual({ confirmedBy: gateways });
    for (const s of seen) {
      expect(s.url).toMatch(/\/thorchain\/vaults\/asgard$/);
      expect(s.init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
      expect(Object.keys(s.init.headers as Record<string, string>)).toEqual(["accept"]);
    }
  });
  it("one answering gateway that does not list it fails closed; a retiring vault is not active; too few lists are an outage", async () => {
    const one = fetchFrom({ ...all(V, W), "https://g3": asgard(V) });
    await expect(thornodeActiveVault("ETH", W, { gateways, fetchFn: one })).rejects.toBeInstanceOf(ProviderCallMismatch);
    await expect(thornodeActiveVault("ETH", W, { gateways, fetchFn: one })).rejects.toThrow(/is not an active THORChain ETH vault on 1 of the 3/);
    await expect(thornodeActiveVault("ETH", RETIRING, { gateways, fetchFn: fetchFrom(all(V, W)) })).rejects.toThrow(/not an active THORChain ETH vault on 3 of the 3/);
    await expect(thornodeActiveVault("ETH", "0x000000000000000000000000000000000000bad1", { gateways, fetchFn: fetchFrom(all(V, W)) })).rejects.toBeInstanceOf(ProviderCallMismatch);
    await expect(thornodeActiveVault("ETH", W, { gateways, fetchFn: fetchFrom({ "https://g1": asgard(V, W) }) })).rejects.toBeInstanceOf(ProviderCallUnverified);
    // a list with no active vault for the chain is no answer (an error page, a gateway mid-restart), never a refusal
    await expect(thornodeActiveVault("ETH", W, { gateways, fetchFn: fetchFrom({ "https://g1": asgard(V, W), "https://g2": [], "https://g3": { error: "x" } }) })).rejects.toThrow(/only 1 of 3 THORNode gateways listed/);
    // two of three answering, both listing it: confirmed by those two
    await expect(thornodeActiveVault("ETH", W, { gateways, fetchFn: fetchFrom({ "https://g1": asgard(V, W), "https://g2": asgard(W) }) })).resolves.toEqual({ confirmedBy: ["https://g1", "https://g2"] });
  });
});

// ---- Chainflip ---------------------------------------------------------------------------------------
describe("Chainflip: vault pinned, the vault swap pays the fresh address, fill-or-kill refunds the escrow", () => {
  // emitted by Chainflip's public backend on 2026-10-06: 1 ETH -> BTC to bc1qar0…, refund 0x2b8D…, retry 100 blocks
  const BACKEND_CALLDATA = "0xdd68734500000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000002a62633171617230737272723778666b7679356c3634336c79646e77397265353967747a7a7766356d647100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006001640000002b8dc27605bf11214247ae11a013fcadf2c1cb6500000000e022ce2f9fc6600300000000000000000000000000000000000000000000000070d0cd75a367987344a3896a18e1510e5429ca5e88357b6c2a2e306b3877380d000000" as Hex;
  const CF_ABI = parseAbi(["function xSwapNative(uint32 dstChain, bytes dstAddress, uint32 dstToken, bytes cfParameters) payable", "function xSwapToken(uint32 dstChain, bytes dstAddress, uint32 dstToken, address srcToken, uint256 amount, bytes cfParameters)"]);
  const le = (v: bigint, n: number) => Array.from({ length: n }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));
  const cfParams = (o: { refund?: string; minPrice?: bigint; retry?: number; boost?: number; brokerBps?: number; dca?: boolean | { chunks: bigint; interval: bigint }; affiliates?: number; trailing?: boolean } = {}): Hex => {
    const b = [1, ...le(BigInt(o.retry ?? 100), 4), ...Array.from(Buffer.from((o.refund ?? ESCROW).slice(2), "hex")), ...le(o.minPrice ?? 1045449873187684626970181632n, 32), 0, 0,
      ...(o.dca ? [1, ...le(typeof o.dca === "object" ? o.dca.chunks : 4n, 4), ...le(typeof o.dca === "object" ? o.dca.interval : 2n, 4)] : [0]), o.boost ?? 0, ...new Array(32).fill(0x70), ...le(BigInt(o.brokerBps ?? 0), 2), o.affiliates ?? 0, ...(o.trailing ? [0] : [])];
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
    expect(c.minOut).toBe(3072301n); // sats, as packages/swap-engine/test/chainflip-unit.test.ts
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
    // a DCA plan (whale spec §12) passes when it and the retry fit a day, and the facts say the min price applies per chunk
    const dca = await checkProviderCall(native({ cf: cfParams({ dca: true }) }), e);
    expect(dca.facts.join(" ")).toMatch(/DCA: 4 chunks, one every 2 block/);
    await refused(checkProviderCall(native({ cf: cfParams({ dca: { chunks: 14_400n, interval: 2n } }) }), e), /dca/);
    await refused(checkProviderCall(native({ cf: cfParams({ dca: { chunks: 0n, interval: 1n } }) }), e), /dca/);
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
  it("bounded as a SWIFT order is: no gas drop, redeem + refund fees within 1 % of the USDC or 2 USDC, Circle's fee within 1 %, a deadline within 6 h (audit 2026-10-16)", async () => {
    // Mayan's verified FastMCTP pays refundFee to whoever calls refund, and for a USDC output that refund is how the order delivers;
    // the ETH call carries the swap's floor of 2,500 USDC: its fee cap is 25 USDC
    await refused(checkProviderCall(ethCall({ data: order({ ...payload(), gasDrop: 1n }) }), e), /fees/);
    await refused(checkProviderCall(ethCall({ data: order({ ...payload(), redeemFee: 20_000_000n, refundFee: 5_000_001n }) }), e), /fees/);
    await expect(checkProviderCall(ethCall({ data: order({ ...payload(), redeemFee: 20_000_000n, refundFee: 5_000_000n }) }), e)).resolves.toMatchObject({ provider: "mayan" });
    await refused(checkProviderCall(ethCall({ data: encodeCreateOrder(USDC.asset, NET, 25_000_001n, 5, 1000, payload()) }), e), /fees/);
    await refused(checkProviderCall(ethCall({ data: order(payload({ deadline: BigInt(NOW + 6 * 3600 + 1) })) }), e), /deadline/);
    await expect(checkProviderCall(ethCall({ data: order(payload({ deadline: BigInt(NOW + 6 * 3600) })) }), e)).resolves.toMatchObject({ provider: "mayan" });
    // a 100 USDC order to Solana as Mayan quoted it (0.49 USDC each, 2026-10-16) passes under the 2 USDC floor; more does not
    const eu = expectation({ from: USDC, to: SOL, destination: DEST_SOL, net: 100_000_000n });
    const small = (redeemFee: bigint, refundFee: bigint) => ({
      provider: PINNED.mayanForwarder, value: 0n,
      calldata: encodeCall("forwardERC20(address,uint256,(uint256,uint256,uint8,bytes32,bytes32),address,bytes)", [
        { t: "address", v: USDC.asset }, { t: "uint", v: 100_000_000n }, { t: "uint", v: 0 }, { t: "uint", v: 0 }, { t: "uint", v: 0 }, { t: "bytes32", v: Buffer.alloc(32) }, { t: "bytes32", v: Buffer.alloc(32) },
        { t: "address", v: MAYAN_FAST_MCTP }, { t: "bytes", v: encodeCreateOrder(USDC.asset, 100_000_000n, 11_001n, 5, 1, { ...payload(), redeemFee, refundFee }) },
      ]) as Hex,
    });
    await expect(checkProviderCall(small(485_407n, 485_407n), eu)).resolves.toMatchObject({ provider: "mayan" });
    await refused(checkProviderCall(small(1_000_000n, 1_000_001n), eu), /fees/);
  });
});

// ---- Mayan SWIFT (forwarder + Swift V2: an auction order, refunded on Ethereum to its trader) ---------------
describe("Mayan SWIFT: Swift V2 and the ETH wrapper pinned, the order pays the fresh address, an unfilled order refunds the escrow", () => {
  const MIN = 2_189_073_633n; // 21.89073633 SOL in Swift's 8 decimals
  const so = (o: Partial<SwiftOrder> = {}): SwiftOrder => ({
    payloadType: 1, trader: addressHex32("ethereum", ESCROW), destAddr: addressHex32("solana", DEST_SOL), destChainId: 1, referrerAddr: Buffer.alloc(32), tokenOut: Buffer.alloc(32),
    minAmountOut: MIN, gasDrop: 0n, cancelFee: 53n, refundFee: 10_651n, deadline: BigInt(NOW + 1500), referrerBps: 0, auctionMode: 2, random: Buffer.alloc(32, 7), ...o,
  });
  const swiftEth = (o: { order?: SwiftOrder; tokenIn?: string; amountIn?: bigint; wrapper?: string; wrapData?: Hex; middle?: string; minMiddle?: bigint } = {}) => ({
    provider: PINNED.mayanForwarder, value: NET,
    calldata: encodeCall("swapAndForwardEth(uint256,address,bytes,address,uint256,address,bytes)", [
      { t: "uint", v: NET }, { t: "address", v: o.wrapper ?? MAYAN_ETH_WRAPPER }, { t: "bytes", v: o.wrapData ?? SEL_WRAP }, { t: "address", v: o.middle ?? WETH_ETHEREUM },
      { t: "uint", v: o.minMiddle ?? NET }, { t: "address", v: MAYAN_SWIFT_V2 }, { t: "bytes", v: encodeSwiftCreateOrder(o.tokenIn ?? ZERO, o.amountIn ?? NET, o.order ?? so()) },
    ]) as Hex,
  });
  const e = expectation({ to: SOL, destination: DEST_SOL });
  it("the engine's ETH order passes: minimum = minAmountOut scaled to SOL's 9 decimals; an unfilled order refunds the escrow", async () => {
    await expect(checkProviderCall(swiftEth(), e)).resolves.toMatchObject({ provider: "mayan", receiver: DEST_SOL, minOut: MIN * 10n, refundTo: "escrow" });
  });
  it("refuses an ETH order not wrapped 1:1 by the pinned wrapper, or not locked as wrap & lock (its refund would not be ETH)", async () => {
    await refused(checkProviderCall(swiftEth({ wrapper: ATTACKER }), e), /swap/);
    await refused(checkProviderCall(swiftEth({ wrapData: "0xd46eb11a" }), e), /swap/);
    await refused(checkProviderCall(swiftEth({ minMiddle: NET - 1n }), e), /swap/);
    await refused(checkProviderCall(swiftEth({ middle: USDC.asset }), e), /swap/);
    await refused(checkProviderCall(swiftEth({ tokenIn: WETH_ETHEREUM }), e), /wrap & lock/);
    await refused(checkProviderCall(swiftEth({ amountIn: NET - 1n }), e), /order/);
  });
  it("swap & lock (Mayan's routing for a small ETH order): a router leg bounded in USDC, the USDC locked; needs a USDC vault for the refund", async () => {
    const ROUTER = "0x0000000000000000000000000000000000000e77";
    const MIN_MIDDLE = 2_500_000_000n;
    const lock = (o: Parameters<typeof swiftEth>[0] = {}) => swiftEth({ wrapper: ROUTER, wrapData: "0x1234", middle: USDC.asset, minMiddle: MIN_MIDDLE, tokenIn: USDC.asset, amountIn: MIN_MIDDLE, ...o });
    const pooled = { ...e, pooled: POOL_USDC };
    const c = await checkProviderCall(lock(), pooled);
    expect(c).toMatchObject({ provider: "mayan", receiver: DEST_SOL, minOut: MIN * 10n, refundTo: "escrow", refundTokens: [USDC.asset] });
    expect(c.refundFloors?.[USDC.asset.toLowerCase()]).toBe((MIN_MIDDLE / 100n).toString());
    expect(c.facts.join(" ")).toMatch(/swapped into USDC .* bounded on chain at 2500000000/);
    await refused(checkProviderCall(lock(), e), /refund/); // no USDC vault: the refund could not be re-shielded
    await refused(checkProviderCall(lock({ minMiddle: 0n }), pooled), /swap/);
    await refused(checkProviderCall(lock({ middle: WETH_ETHEREUM }), pooled), /swap/);
    await refused(checkProviderCall(lock({ tokenIn: ZERO }), pooled), /order/);
    await refused(checkProviderCall(lock({ amountIn: MIN_MIDDLE - 1n }), pooled), /order/);
  });
  it("refuses a trader other than the escrow, another receiver, chain or token out, a gas drop, a referrer, fees above 1%, a custom payload, a deadline past or beyond 6 h", async () => {
    const onePercent = NET / 10n ** 10n / 100n; // of the order in Swift's 8 decimals
    const bad: [Partial<SwiftOrder>, RegExp][] = [
      [{ trader: addressHex32("ethereum", ATTACKER) }, /refund/],
      [{ destAddr: addressHex32("solana", "11111111111111111111111111111112") }, /receiver/],
      [{ destChainId: 30 }, /chain/],
      [{ tokenOut: addressHex32("ethereum", USDC.asset) }, /asset/],
      [{ gasDrop: 1n }, /gas drop/],
      [{ referrerAddr: addressHex32("ethereum", ATTACKER), referrerBps: 50 }, /fees/],
      [{ cancelFee: 0n, refundFee: onePercent + 1n }, /fees/],
      [{ payloadType: 2 }, /payload/],
      [{ deadline: BigInt(NOW) }, /deadline/],
      [{ deadline: BigInt(NOW + 6 * 3600 + 1) }, /deadline/],
      [{ auctionMode: 0 }, /auction/],
    ];
    for (const [o, why] of bad) await refused(checkProviderCall(swiftEth({ order: so(o) }), e), why);
    await expect(checkProviderCall(swiftEth({ order: so({ cancelFee: 0n, refundFee: onePercent }) }), e), "fees of exactly 1% pass").resolves.toMatchObject({ refundTo: "escrow" });
  });
  it("a USDC order locks USDC itself through forwardERC20, exactly the net amount", async () => {
    const NET_USDC = 2_000_000_000n;
    const eu = expectation({ from: USDC, to: SOL, destination: DEST_SOL, net: NET_USDC });
    const erc = (o: { tokenIn?: string; amountIn?: bigint } = {}) => ({
      provider: PINNED.mayanForwarder, value: 0n,
      calldata: encodeCall("forwardERC20(address,uint256,(uint256,uint256,uint8,bytes32,bytes32),address,bytes)", [
        { t: "address", v: USDC.asset }, { t: "uint", v: NET_USDC }, { t: "uint", v: 0 }, { t: "uint", v: 0 }, { t: "uint", v: 0 }, { t: "bytes32", v: Buffer.alloc(32) }, { t: "bytes32", v: Buffer.alloc(32) },
        { t: "address", v: MAYAN_SWIFT_V2 }, { t: "bytes", v: encodeSwiftCreateOrder(o.tokenIn ?? USDC.asset, o.amountIn ?? NET_USDC, so({ cancelFee: 1338n, refundFee: 272_870n })) },
      ]) as Hex,
    });
    await expect(checkProviderCall(erc(), eu)).resolves.toMatchObject({ provider: "mayan", receiver: DEST_SOL, minOut: MIN * 10n, refundTo: "escrow" });
    await refused(checkProviderCall(erc({ tokenIn: ZERO }), eu), /locks/);
    await refused(checkProviderCall(erc({ amountIn: NET_USDC - 1n }), eu), /order/);
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
  "function startBridgeTokensViaAcrossV4(BridgeData _bridgeData, AcrossV4Data _acrossData) payable",
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
  it("the facet never asks Across for more than it bridges: one unit of minAmount under an inflated multiplier, or a multiplier above one, is refused by both (audit 2026-10-16)", async () => {
    // the swap variant hands Across (swap result, at least minAmount) × multiplier / 1e18: one unit of minAmount under a multiplier of
    // FLOOR × 1e18 reads as the honest minimum, while the source swap (calldata the diamond runs as given) could keep the order
    const inflated = acrossCall(bridgeData({ minAmount: 1n }), undefined, acrossData({ outputAmountMultiplier: FLOOR * 10n ** 18n, outputAmount: FLOOR }));
    await refused(checkProviderCall(inflated, e), /minimum/);
    expect(() => serviceVerify(inflated.calldata, FLOOR)).toThrow(/asks Across for more than the swap bridges/);
    const above = acrossCall(undefined, undefined, acrossData({ outputAmountMultiplier: 10n ** 18n + 1n, outputAmount: (MIN_AMOUNT * (10n ** 18n + 1n)) / 10n ** 18n }));
    await refused(checkProviderCall(above, e), /minimum/);
    expect(() => serviceVerify(above.calldata, MIN_AMOUNT)).toThrow(/outputAmountMultiplier/);
    // a multiplier of exactly one passes: the swap's floor is then the minimum
    const one = acrossCall(undefined, undefined, acrossData({ outputAmountMultiplier: 10n ** 18n, outputAmount: MIN_AMOUNT }));
    await expect(checkProviderCall(one, e)).resolves.toMatchObject({ minOut: MIN_AMOUNT });
    expect(serviceVerify(one.calldata, MIN_AMOUNT).verified).toContain("bridged amount backs the output");
  });
  it("the bridged token must be the asset delivered: USDC bridged for an ETH output, under a multiplier within USDC's decimals, is refused by both (audit 2026-10-16)", async () => {
    // an ETH order's escrow re-shields the pool's USDC, but a USDC floor is no floor for ETH: in nominal units a million-unit
    // minAmount (one USDC) under FLOOR × 1e12 reads as the honest ETH minimum, and an unfilled deposit would refund one USDC
    const crossAsset = acrossCall(bridgeData({ sendingAssetId: USDC.asset, minAmount: 1_000_000n }), feeSwap({ receivingAssetId: USDC.asset }), acrossData({ sendingAssetId: bytes32Of("ethereum", USDC.asset), outputAmountMultiplier: FLOOR * 10n ** 12n, outputAmount: FLOOR }));
    await refused(checkProviderCall(crossAsset, { ...e, pooled: POOL_USDC }), /asset/);
    const saved = process.env.ERC20_VAULTS;
    process.env.ERC20_VAULTS = `${USDC.asset}:0x0000000000000000000000000000000000000a11`;
    try { expect(() => serviceVerify(crossAsset.calldata, FLOOR)).toThrow(/counted in the asset delivered/); }
    finally { if (saved === undefined) delete process.env.ERC20_VAULTS; else process.env.ERC20_VAULTS = saved; }
  });
  it("one dollar stablecoin counts for another: LI.FI's own route to USDC on Base through a USDT deposit (2026-10) passes both, with the pool's USDT vault", async () => {
    const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address;
    const viaUsdt = acrossCall(bridgeData({ sendingAssetId: USDT, minAmount: 2_455_342_549n }), feeSwap({ receivingAssetId: USDT }), acrossData({ sendingAssetId: bytes32Of("ethereum", USDT), receivingAssetId: bytes32Of("base", USDC_BASE.asset), outputAmountMultiplier: 998_784_978_087_389_468n, outputAmount: 2_452_359_254n }));
    const eu = expectation({ to: USDC_BASE, destination: DEST_EVM, pooled: [{ token: USDT, symbol: "USDT", decimals: 6 }] });
    await expect(checkProviderCall(viaUsdt, eu)).resolves.toMatchObject({ minOut: 2_452_359_254n, refundTokens: [getAddress(USDT)] });
    const saved = process.env.ERC20_VAULTS;
    process.env.ERC20_VAULTS = `${USDT}:0x0000000000000000000000000000000000000a11`;
    try {
      const v = verifyLifiTransaction(
        { from: ETH as any, to: USDC_BASE as any, amount: NET, destination: DEST_EVM, source: ESCROW, slippageBps: 50 },
        { tool: "across", transactionRequest: { to: LIFI_DIAMOND.ethereum, data: viaUsdt.calldata, value: "0x" + NET.toString(16), chainId: 1 }, action: { fromAddress: ESCROW, toAddress: DEST_EVM, fromChainId: 1, toChainId: 8453 }, estimate: { toAmountMin: "2452359254" } },
      );
      expect(v.verified).toContain("bridged amount backs the output");
    } finally {
      if (saved === undefined) delete process.env.ERC20_VAULTS; else process.env.ERC20_VAULTS = saved;
    }
  });
  it("the bridge alone: an outputAmount above what is bridged is refused by both; within it the exact fill passes (audit 2026-10-16)", async () => {
    const plain = (out: bigint) => ({ provider: PINNED.lifiDiamond, value: NET, calldata: encodeFunctionData({ abi: LIFI_ABI, functionName: "startBridgeTokensViaAcrossV4", args: [bridgeData({ hasSourceSwaps: false, minAmount: NET }) as any, acrossData({ outputAmount: out }) as any] }) });
    await expect(checkProviderCall(plain(NET - 1000n), e)).resolves.toMatchObject({ minOut: NET - 1000n });
    expect(serviceVerify(plain(NET - 1000n).calldata, NET - 1000n).verified).toContain("bridged amount backs the output");
    await refused(checkProviderCall(plain(NET + 1n), e), /minimum/);
    expect(() => serviceVerify(plain(NET + 1n).calldata, NET)).toThrow(/more than the \d+ bridged/);
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
    expect((await checkProviderCall(intoWeth, e)).refundTokens, "WETH needs no refundToken").toBeUndefined();
    expect(serviceVerify(intoWeth.calldata, FLOOR).verified).toContain("refunds re-shieldable");
    // into a token the pool has a vault for, it passes too: the escrow's refundToken re-shields it there, and both
    // sides name it as the token the executor must watch
    const eu = expectation({ to: USDC_BASE, destination: DEST_EVM, pooled: POOL_USDC });
    await expect(checkProviderCall(intoUsdc, eu)).resolves.toMatchObject({ refundTo: "escrow", refundTokens: [getAddress(USDC.asset)], refundFloors: { [USDC.asset.toLowerCase()]: (MIN_AMOUNT / 100n).toString() } });
    const saved = process.env.ERC20_VAULTS;
    process.env.ERC20_VAULTS = `${USDC.asset}:0x0000000000000000000000000000000000000a11`;
    try {
      const v = verifyLifiTransaction(
        { from: ETH as any, to: USDC_BASE as any, amount: NET, destination: DEST_EVM, source: ESCROW, slippageBps: 50 },
        { tool: "across", transactionRequest: { to: LIFI_DIAMOND.ethereum, data: intoUsdc.calldata, value: "0x" + NET.toString(16), chainId: 1 }, action: { fromAddress: ESCROW, toAddress: DEST_EVM, fromChainId: 1, toChainId: 8453 }, estimate: { toAmountMin: "1" } },
      );
      expect(v.refundTokens).toEqual([USDC.asset.toLowerCase()]);
    } finally {
      if (saved === undefined) delete process.env.ERC20_VAULTS; else process.env.ERC20_VAULTS = saved;
    }
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

describe("Across swap leg: periphery and SpokePool pinned; the pinned handler hands the output token to the fresh address", () => {
  const PERIPHERY_ABI = parseAbi([
    "struct Fees { uint256 amount; address recipient; }",
    "struct BaseDepositData { address inputToken; bytes32 outputToken; uint256 outputAmount; address depositor; bytes32 recipient; uint256 destinationChainId; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }",
    "struct SwapAndDepositData { Fees submissionFees; BaseDepositData depositData; address swapToken; address exchange; uint8 transferType; uint256 swapTokenAmount; uint256 minExpectedInputTokenAmount; bytes routerCalldata; bool enableProportionalAdjustment; address spokePool; uint256 nonce; }",
    "function swapAndBridge(SwapAndDepositData swapAndDepositData) payable",
  ]);
  const HANDLER_MESSAGE = [{ type: "tuple", components: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "callData", type: "bytes" }, { name: "value", type: "uint256" }] }, { name: "fallbackRecipient", type: "address" }] }] as const;
  const handlerAbi = parseAbi(["function drainLeftoverTokens(address token, address destination)", "function emitData(bytes data)"]);
  const HANDLER = ACROSS_DESTINATION.handler.base, EMITTER = ACROSS_DESTINATION.emitter.base;
  type Call = { target: Address; callData: Hex; value: bigint };
  const drain = (token: string = USDC_BASE.asset, to: string = DEST_EVM, target: Address = HANDLER): Call => ({ target, callData: encodeFunctionData({ abi: handlerAbi, functionName: "drainLeftoverTokens", args: [token as Address, to as Address] }), value: 0n });
  const emit = (target: Address = EMITTER): Call => ({ target, callData: encodeFunctionData({ abi: handlerAbi, functionName: "emitData", args: ["0x1234"] }), value: 0n });
  // what the Swap API sends (2026-10): drain twice, emit twice, no fallback recipient
  const message = (calls: Call[] = [drain(), drain(), emit(), emit()], fallbackRecipient: Address = ZERO) => encodeAbiParameters(HANDLER_MESSAGE, [{ calls, fallbackRecipient }]);
  const OUT = 2_573_849_471n;
  const data = (o: Record<string, unknown> = {}, dd: Record<string, unknown> = {}) => ({
    submissionFees: { amount: 0n, recipient: ZERO },
    depositData: { inputToken: USDC.asset as Address, outputToken: bytes32Of("base", USDC_BASE.asset), outputAmount: OUT, depositor: ESCROW, recipient: bytes32Of("base", HANDLER), destinationChainId: 8453n, exclusiveRelayer: padHex("0x", { size: 32 }), quoteTimestamp: NOW - 10, fillDeadline: NOW + 7200, exclusivityParameter: 0, message: message(), ...dd },
    swapToken: ENGINE_WETH.ethereum as Address, exchange: PINNED.lifiDiamond, transferType: 0, swapTokenAmount: NET, minExpectedInputTokenAmount: 2_593_233_999n, routerCalldata: "0xabcd" as Hex, enableProportionalAdjustment: true, spokePool: PINNED.acrossSpokePool, nonce: 0n, ...o,
  });
  const call = (o?: Record<string, unknown>, dd?: Record<string, unknown>, value = NET) => ({ provider: PINNED.acrossPeriphery, value, calldata: encodeFunctionData({ abi: PERIPHERY_ABI, functionName: "swapAndBridge", args: [data(o, dd) as any] }) });
  const e = expectation({ to: USDC_BASE, destination: DEST_EVM, pooled: POOL_USDC });
  // the swap service's own decoder (acrossSwap.ts) on the same calldata: both must agree
  const req = { from: ETH, to: USDC_BASE, amount: NET, destination: DEST_EVM, source: ESCROW, slippageBps: 50 } as any;
  const pins = () => acrossSwapPins(req, { spokePool: SPOKE_POOL, weth: ENGINE_WETH, chainId: { ethereum: 1, base: 8453, arbitrum: 42161, optimism: 10 } });
  const serviceVerify = (calldata: Hex, value = NET) => {
    const saved = process.env.ERC20_VAULTS;
    process.env.ERC20_VAULTS = `${USDC.asset}:0x0000000000000000000000000000000000000a11`;
    try { return verifyAcrossSwapCall(req, { to: PINNED.acrossPeriphery, data: calldata, value }, pins()); }
    finally { if (saved === undefined) delete process.env.ERC20_VAULTS; else process.env.ERC20_VAULTS = saved; }
  };

  it("the pins equal the swap service's", () => {
    expect(PINNED.acrossPeriphery.toLowerCase()).toBe(ACROSS_PERIPHERY.ethereum);
    expect(toFunctionSelector(PERIPHERY_ABI.find((x: any) => x.name === "swapAndBridge") as any)).toBe(SEL_SWAP_AND_BRIDGE);
    for (const chain of ["optimism", "base", "arbitrum"]) {
      expect(ACROSS_DESTINATION.handler[chain].toLowerCase()).toBe(ACROSS_MULTICALL_HANDLER[chain]);
      expect(ACROSS_DESTINATION.emitter[chain].toLowerCase()).toBe(ACROSS_EVENT_EMITTER[chain]);
    }
  });
  it("the API's shape passes both: the handler drains USDC to the fresh address, minimum = the deposit's output, USDC is the token to watch", async () => {
    const honest = call();
    const c = await checkProviderCall(honest, e);
    expect(c).toMatchObject({ provider: "across", receiver: DEST_EVM, minOut: OUT, refundTo: "escrow", refundTokens: [getAddress(USDC.asset)] });
    expect(c.refundFloors, "PP-S12: 1% of the least an unfilled deposit returns").toEqual({ [USDC.asset.toLowerCase()]: (2_593_233_999n / 100n).toString() });
    const v = serviceVerify(honest.calldata);
    expect(v.minOut).toBe(OUT);
    expect(v.refundTokens).toEqual([USDC.asset.toLowerCase()]);
    // a fill straight to the fresh address, without a message, passes too
    const direct = call(undefined, { recipient: bytes32Of("base", DEST_EVM), message: "0x" });
    await expect(checkProviderCall(direct, e)).resolves.toMatchObject({ minOut: OUT });
    expect(serviceVerify(direct.calldata).verified).toContain("receiver");
  });
  it("refuses another SpokePool, depositor, swap token or amount, value, output token or chain; a fee; a nonce", async () => {
    const bent: [Record<string, unknown> | undefined, Record<string, unknown> | undefined, bigint | undefined, RegExp][] = [
      [{ spokePool: ATTACKER }, undefined, undefined, /contract/],
      [undefined, { depositor: ATTACKER }, undefined, /refund/],
      [{ swapToken: USDC.asset }, undefined, undefined, /amount/],
      [{ swapTokenAmount: NET / 2n }, undefined, undefined, /amount/],
      [undefined, undefined, NET * 2n, /amount/],
      [undefined, { outputToken: bytes32Of("base", ENGINE_WETH.base) }, undefined, /asset/],
      [undefined, { destinationChainId: 42161n }, undefined, /chain/],
      [{ submissionFees: { amount: 1n, recipient: ATTACKER } }, undefined, undefined, /fee/],
      [{ nonce: 7n }, undefined, undefined, /fee/],
    ];
    for (const [o, dd, value, field] of bent) {
      const x = call(o, dd, value);
      await refused(checkProviderCall(x, e), field);
      expect(() => serviceVerify(x.calldata, value ?? NET), `the service too: ${field}`).toThrow();
    }
  });
  it("refuses a message that drains elsewhere or another token, calls anything else, forwards value, names another fallback, or drains nothing", async () => {
    const msgs: [Hex, RegExp][] = [
      [message([drain(USDC_BASE.asset, ATTACKER), emit()]), /receiver/],
      [message([drain(ENGINE_WETH.base), emit()]), /receiver/],
      [message([drain(), { target: ATTACKER, callData: "0x12345678", value: 0n }]), /message/],
      [message([drain(), emit(ATTACKER)]), /message/],
      [message([{ ...drain(), value: 1n }]), /message/],
      [message([drain()], ATTACKER), /receiver/],
      [message([emit(), emit()]), /receiver/],
    ];
    for (const [m, field] of msgs) {
      const x = call(undefined, { message: m });
      await refused(checkProviderCall(x, e), field);
      expect(() => serviceVerify(x.calldata), `the service too: ${field}`).toThrow();
    }
    // a fallback recipient that is the fresh address hands over what the calls leave: no drain call needed
    await expect(checkProviderCall(call(undefined, { message: message([emit()], DEST_EVM) }), e)).resolves.toMatchObject({ receiver: DEST_EVM });
  });
  it("the swap's own floor backs the deposit: a floor of one unit, or one unit short of the output, is refused by both; a floor that covers it passes whatever the exchange (audit 2026-10-16)", async () => {
    // the exchange and its calldata stay opaque: the periphery reverts below the floor, and a deposit nobody fills refunds the escrow
    // at least the floor. Before, a floor of one unit let an exchange of the caller's choosing keep the order and return one unit
    for (const floor of [1n, OUT - 1n]) {
      const x = call({ minExpectedInputTokenAmount: floor, exchange: ATTACKER, transferType: 1 });
      await refused(checkProviderCall(x, e), /minimum/);
      expect(() => serviceVerify(x.calldata), `the service too: a floor of ${floor}`).toThrow(/floor/);
    }
    const exact = call({ minExpectedInputTokenAmount: OUT, exchange: ATTACKER, transferType: 1 });
    await expect(checkProviderCall(exact, e)).resolves.toMatchObject({ minOut: OUT });
    expect(serviceVerify(exact.calldata).verified).toContain("swap floor covers the output");
  });
  it("the swapped-into token must be the asset delivered: WETH bridged for USDC, or the pool's USDC for ETH, is refused by both (audit 2026-10-16)", async () => {
    // an ETH order's escrow re-shields WETH and the pool's USDC, but a floor counts only for the asset delivered: counted in the other
    // asset's units, it would be a sliver of the order (three USDC "cover" two ETH in nominal units)
    const wethForUsdc = call(undefined, { inputToken: ENGINE_WETH.ethereum });
    await refused(checkProviderCall(wethForUsdc, e), /asset/);
    expect(() => serviceVerify(wethForUsdc.calldata)).toThrow(/counted in the asset delivered/);
    const usdcForEth = call({ minExpectedInputTokenAmount: 3_000_000n }, { outputToken: bytes32Of("base", ENGINE_WETH.base), outputAmount: 2n * 10n ** 18n, recipient: bytes32Of("base", DEST_EVM), message: "0x" });
    await refused(checkProviderCall(usdcForEth, { ...e, to: ETH_BASE }), /asset/);
    const reqEth = { ...req, to: ETH_BASE };
    const saved = process.env.ERC20_VAULTS;
    process.env.ERC20_VAULTS = `${USDC.asset}:0x0000000000000000000000000000000000000a11`;
    try { expect(() => verifyAcrossSwapCall(reqEth, { to: PINNED.acrossPeriphery, data: usdcForEth.calldata, value: NET }, acrossSwapPins(reqEth, { spokePool: SPOKE_POOL, weth: ENGINE_WETH, chainId: { ethereum: 1, base: 8453, arbitrum: 42161, optimism: 10 } }))).toThrow(/counted in the asset delivered/); }
    finally { if (saved === undefined) delete process.env.ERC20_VAULTS; else process.env.ERC20_VAULTS = saved; }
  });
  it("refuses a swap into a token the pool has no vault for (PP-S08), and a call delivering another asset than asked", async () => {
    await refused(checkProviderCall(call(), { ...e, pooled: [] }), /refund/);
    expect(() => verifyAcrossSwapCall(req, { to: PINNED.acrossPeriphery, data: call().calldata, value: NET }, pins())).toThrow(/cannot re-shield/);
    await refused(checkProviderCall(call(), { ...e, to: ETH_BASE }), /asset/);
  });

  // a native destination (USDC on Ethereum -> ETH on Base, 2026-10): the swap yields WETH, Across bridges WETH, and the
  // handler unwraps its WETH (makeCallWithBalance(WETH, withdraw(0), 0, [{WETH, 4}])) before draining ETH to the fresh address
  const balanceAbi = parseAbi(["function makeCallWithBalance(address target, bytes callData, uint256 value, (address token, uint256 offset)[] replacement)", "function withdraw(uint256 wad)", "function transfer(address to, uint256 amount)"]);
  const WETH_B = ENGINE_WETH.base as Address;
  const unwrap = (o: { target?: Address; inner?: Hex; value?: bigint; token?: Address; offset?: bigint } = {}): Call => ({
    target: HANDLER, value: 0n,
    callData: encodeFunctionData({ abi: balanceAbi, functionName: "makeCallWithBalance", args: [o.target ?? WETH_B, o.inner ?? encodeFunctionData({ abi: balanceAbi, functionName: "withdraw", args: [0n] }), o.value ?? 0n, [{ token: o.token ?? WETH_B, offset: o.offset ?? 4n }]] }),
  });
  const NET_USDC = 2_000_000_000n;
  const nativeCall = (calls: Call[], o: Record<string, unknown> = {}) => ({ provider: PINNED.acrossPeriphery, value: 0n, calldata: encodeFunctionData({ abi: PERIPHERY_ABI, functionName: "swapAndBridge", args: [data({ swapToken: USDC.asset, swapTokenAmount: NET_USDC, ...o }, { inputToken: ENGINE_WETH.ethereum, outputToken: bytes32Of("base", WETH_B), message: message(calls) }) as any] }) });
  const en = expectation({ from: USDC, to: ETH_BASE, destination: DEST_EVM, net: NET_USDC, pooled: [] }); // no WETH vault: the escrow re-shields WETH as ETH
  const reqN = { from: USDC, to: ETH_BASE, amount: NET_USDC, destination: DEST_EVM, source: ESCROW, slippageBps: 50 } as any;
  const serviceNative = (calldata: Hex) => {
    const saved = process.env.ERC20_VAULTS;
    process.env.ERC20_VAULTS = "";
    try { return verifyAcrossSwapCall(reqN, { to: PINNED.acrossPeriphery, data: calldata, value: 0n }, acrossSwapPins(reqN, { spokePool: SPOKE_POOL, weth: ENGINE_WETH, chainId: { ethereum: 1, base: 8453, arbitrum: 42161, optimism: 10 } })); }
    finally { if (saved === undefined) delete process.env.ERC20_VAULTS; else process.env.ERC20_VAULTS = saved; }
  };
  it("a native destination: the API's shape (unwrap, drain ETH, drain WETH) passes both decoders; WETH is the token an unfilled deposit comes back in, re-shielded as ETH with no WETH vault", async () => {
    const honest = nativeCall([unwrap(), drain(ZERO), drain(WETH_B), emit(), emit()]);
    const checked = await checkProviderCall(honest, en);
    expect(checked).toMatchObject({ provider: "across", receiver: DEST_EVM, minOut: OUT, refundTokens: [getAddress(ENGINE_WETH.ethereum)] });
    expect(checked.facts.join(" | ")).toMatch(/re-shields as ETH/);
    expect(serviceNative(honest.calldata).refundTokens).toEqual([ENGINE_WETH.ethereum.toLowerCase()]);
  });
  it("a native destination: a WETH floor below the output is refused by both (audit 2026-10-16)", async () => {
    const x = nativeCall([unwrap(), drain(ZERO), drain(WETH_B), emit(), emit()], { minExpectedInputTokenAmount: 1n });
    await refused(checkProviderCall(x, en), /minimum/);
    expect(() => serviceNative(x.calldata)).toThrow(/floor/);
  });
  it("a native destination: refuses ETH drained before the unwrap, an unwrap of anything but the handler's own WETH, and no ETH drain at all", async () => {
    const bad: Call[][] = [
      [drain(ZERO), unwrap(), drain(WETH_B)], // the ETH would be left in the handler
      [unwrap({ target: ATTACKER }), drain(ZERO)],
      [unwrap({ inner: encodeFunctionData({ abi: balanceAbi, functionName: "transfer", args: [ATTACKER, 0n] }) }), drain(ZERO)],
      [unwrap({ offset: 36n }), drain(ZERO)],
      [unwrap({ token: USDC_BASE.asset as Address }), drain(ZERO)],
      [unwrap({ value: 1n }), drain(ZERO)],
      [unwrap(), drain(WETH_B)], // WETH, not the ETH asked for
    ];
    for (const calls of bad) {
      const x = nativeCall(calls);
      await expect(checkProviderCall(x, en)).rejects.toThrow(ProviderCallMismatch);
      expect(() => serviceNative(x.calldata), "the service too").toThrow();
    }
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
