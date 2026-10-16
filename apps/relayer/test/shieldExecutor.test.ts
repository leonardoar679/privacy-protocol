// The shield executor (spec v2.0 §11.2; V6 Stage 12) on a mock chain: the receiver it watches is the address forge's
// factory predicts (contracts/test/periphery/vectors/shield.json); a job is accepted only for this relayer's factory, with
// parameters a receiver accepts, the payload that hashes to the committed one and a canonical vault; it sends
// deployAndShield once a delivery of at least the minimum arrived, records the leaf, the deposit and the tip from the
// receiver's event, waits while an ETH shield would cost more than its tip (until the swap is over), bounds the shields
// no tip pays for, expires a receipt nothing reached, and never runs two passes at once; a shield the node dropped sends
// the job back and is shielded again (a V6 follow-up of 2026-10-15). No real chain, no funds.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  http,
  keccak256,
  parseTransaction,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ABI, predictReceiver, receiverParamsJson, receiverParamsOf, type ReceiverParams } from "@privacy-wallet/contracts";
import { ShieldExecutor, ShieldJobError, type ShieldJobRequest } from "../src/shieldExecutor";
import { DROP_AFTER_MS } from "../src/sender";
import { orderSignerAddress, shieldVouchDigest, signExecution } from "@privacy-wallet/swap-engine/endpoints";
import { VOUCHER, VOUCH_KEY } from "./vouch";
import vector from "../../../contracts/test/periphery/vectors/shield.json";

const CHAIN_ID = 1;
const RELAYER_KEY = ("0x" + "7e".repeat(32)) as Hex;
const FACTORY = "0x00000000000000000000000000000000000000f2" as Address;
const VAULT_FACTORY = "0x00000000000000000000000000000000000000f1" as Address;
const ETH_VAULT = "0x00000000000000000000000000000000000000e1" as Address;
const NOTE_DATA = ("0x01" + "ab".repeat(168)) as Hex;
const TIP = 2_000_000_000_000_000n; // 0.002 ETH
const params: ReceiverParams = {
  receiptId: ("0x" + "5e".repeat(32)) as Hex,
  asset: "0x0000000000000000000000000000000000000000",
  minAmount: TIP * 100n,
  shieldTip: TIP,
  ownerCommitment: 4660n,
  noteSecret: 22136n,
  noteDataHash: keccak256(NOTE_DATA),
  fallbackRecipient: "0x00000000000000000000000000000000000000fa",
};
const RECEIVER = predictReceiver(FACTORY, params);

// ---- mock JSON-RPC ----
const sel = (sig: string) => toFunctionSelector(sig).slice(2);
const word = (x: bigint | string) => (typeof x === "bigint" ? x.toString(16) : x.slice(2).toLowerCase()).padStart(64, "0");
const raws: Hex[] = [];
let receiverEth = 0n;
let vaultOfAsset: Address = ETH_VAULT;
let deployed = false;
let tipPaid = false;
let revertEstimate = false;
let gasPrice = 1_000_000_000n; // 1 gwei: a 500k-gas shield costs 0.0005 ETH, below the 0.002 tip
let receipt: { status: "0x1" | "0x0"; amount: bigint; tip: bigint; leafIndex: number } | null = null;
const dropped = new Set<Hex>(); // transactions the node no longer knows
const GAS = 500_000n;
const shieldedTopics = (vault: Address) => encodeEventTopics({ abi: ABI.shieldReceiver, eventName: "Shielded", args: { vault } } as never);
function call(to: string, data: string): string {
  const s = data.slice(2, 10);
  if (s === sel("VAULT_FACTORY()")) return "0x" + word(VAULT_FACTORY);
  if (s === sel("WRAPPED_NATIVE()")) return "0x" + word(0n);
  if (s === sel("vaultOf(address)")) return "0x" + word(vaultOfAsset);
  if (s === sel("tipPaid()")) return "0x" + word(tipPaid ? 1n : 0n);
  throw new Error(`mock rpc: eth_call ${to} ${s}`);
}
function handle(req: { id: number; method: string; params: any[] }) {
  const res = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  switch (req.method) {
    case "eth_chainId":
      return res(toHex(CHAIN_ID));
    case "eth_blockNumber":
      return res("0x10");
    case "eth_getBlockByNumber":
      return res({
        number: "0x10",
        hash: "0x" + "11".repeat(32),
        parentHash: "0x" + "00".repeat(32),
        nonce: "0x0000000000000000",
        sha3Uncles: "0x" + "00".repeat(32),
        logsBloom: "0x" + "00".repeat(256),
        transactionsRoot: "0x" + "00".repeat(32),
        stateRoot: "0x" + "00".repeat(32),
        receiptsRoot: "0x" + "00".repeat(32),
        miner: "0x" + "00".repeat(20),
        difficulty: "0x0",
        totalDifficulty: "0x0",
        extraData: "0x",
        size: "0x1",
        gasLimit: "0x1c9c380",
        gasUsed: "0x0",
        timestamp: "0x1",
        baseFeePerGas: "0x3b9aca00",
        mixHash: "0x" + "00".repeat(32),
        transactions: [],
        uncles: [],
      });
    case "eth_gasPrice":
      return res(toHex(gasPrice));
    case "eth_maxPriorityFeePerGas":
      return res("0x3b9aca00");
    case "eth_getTransactionCount":
      return res("0x1");
    case "eth_getBalance":
      return res(toHex(req.params[0].toLowerCase() === RECEIVER.toLowerCase() ? receiverEth : 0n));
    case "eth_getCode":
      return res(deployed && req.params[0].toLowerCase() === RECEIVER.toLowerCase() ? "0x6001" : "0x");
    case "eth_call":
      try {
        return res(call(req.params[0].to, req.params[0].data ?? req.params[0].input));
      } catch (e) {
        return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: (e as Error).message } };
      }
    case "eth_estimateGas":
      return revertEstimate ? { jsonrpc: "2.0", id: req.id, error: { code: 3, message: "execution reverted: NoVault()" } } : res(toHex(GAS));
    case "eth_sendRawTransaction":
      raws.push(req.params[0]);
      return res(keccak256(req.params[0]));
    case "eth_getTransactionByHash":
      return res(
        raws.some((r) => keccak256(r) === req.params[0]) && !dropped.has(req.params[0])
          ? {
              hash: req.params[0],
              nonce: "0x1",
              from: "0x" + "00".repeat(20),
              to: "0x" + "00".repeat(20),
              input: "0x",
              value: "0x0",
              gas: "0x5208",
              blockHash: null,
              blockNumber: null,
              transactionIndex: null,
              type: "0x2",
              chainId: "0x1",
              maxFeePerGas: "0x77359400",
              maxPriorityFeePerGas: "0x3b9aca00",
              v: "0x0",
              yParity: "0x0",
              r: "0x1",
              s: "0x1",
            }
          : null,
      );
    case "eth_getTransactionReceipt": {
      if (!receipt) return res(null);
      const logs =
        receipt.status === "0x1"
          ? [
              {
                address: RECEIVER,
                topics: shieldedTopics(ETH_VAULT),
                data: encodeAbiParameters(
                  [{ type: "uint256" }, { type: "uint256" }, { type: "uint32" }, { type: "address" }],
                  [receipt.amount, receipt.tip, receipt.leafIndex, privateKeyToAccount(RELAYER_KEY).address],
                ),
                blockNumber: "0x11",
                blockHash: "0x" + "11".repeat(32),
                transactionHash: req.params[0],
                transactionIndex: "0x0",
                logIndex: "0x0",
                removed: false,
              },
            ]
          : [];
      return res({
        transactionHash: req.params[0],
        status: receipt.status,
        blockNumber: "0x11",
        blockHash: "0x" + "11".repeat(32),
        transactionIndex: "0x0",
        from: "0x" + "00".repeat(20),
        to: FACTORY,
        cumulativeGasUsed: "0x1",
        gasUsed: toHex(400_000n),
        effectiveGasPrice: toHex(1_000_000_000n),
        logs,
        logsBloom: "0x" + "00".repeat(256),
        type: "0x2",
      });
    }
    default:
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `mock rpc: ${req.method} unsupported` } };
  }
}

let server: Server;
let clock = 1_000;
let clients: { publicClient: any; walletClient: any; account: ReturnType<typeof privateKeyToAccount> };
const executor = (o: { maxUnpaidShields?: number; voucher?: Address | Address[] } = {}) =>
  new ShieldExecutor({ factory: FACTORY, ...clients, now: () => clock, lateDeliveryWatchSeconds: 600, chainId: CHAIN_ID, voucher: VOUCHER, ...o });
/** the swap service's vouch for a receipt (a V6 follow-up of 2026-10-16): over its receiver */
const vouchFor = (r: ShieldJobRequest, key = VOUCH_KEY): Hex | undefined => {
  try {
    return signExecution(key, shieldVouchDigest(BigInt(CHAIN_ID), predictReceiver(r.factory, receiverParamsOf(r.params))));
  } catch {
    return undefined; // parameters the receiver cannot take: the executor refuses them before the vouch
  }
};
const request = (over: Partial<ShieldJobRequest> = {}): ShieldJobRequest => {
  const r: ShieldJobRequest = { factory: FACTORY, params: receiverParamsJson(params), noteData: NOTE_DATA, deliverBy: 2_000, ...over };
  return "vouch" in over ? r : { ...r, vouch: vouchFor(r) };
};
const sentShield = (raw: Hex) => decodeFunctionData({ abi: ABI.shieldReceiverFactory, data: parseTransaction(raw).data! });

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(j) ? j.map(handle) : handle(j)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const rpcUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const chain = {
    id: CHAIN_ID,
    name: "test",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;
  const transport = http(rpcUrl, { batch: true });
  const account = privateKeyToAccount(RELAYER_KEY);
  clients = { account, publicClient: createPublicClient({ chain, transport }), walletClient: createWalletClient({ account, chain, transport }) };
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  raws.length = 0;
  receiverEth = 0n;
  vaultOfAsset = ETH_VAULT;
  deployed = false;
  tipPaid = false;
  revertEstimate = false;
  gasPrice = 1_000_000_000n;
  receipt = null;
  dropped.clear();
  clock = 1_000;
});

describe("the receiver it watches", () => {
  it("is forge's prediction: the vector's parameters give the vector's address", () => {
    const v = vector as Record<string, string>;
    const p: ReceiverParams = {
      receiptId: v.receiptId as Hex,
      asset: v.asset as Address,
      minAmount: BigInt(v.minAmount),
      shieldTip: BigInt(v.shieldTip),
      ownerCommitment: BigInt(v.ownerCommitment),
      noteSecret: BigInt(v.noteSecret),
      noteDataHash: v.noteDataHash as Hex,
      fallbackRecipient: v.fallbackRecipient as Address,
    };
    expect(predictReceiver(v.factory as Address, p)).toBe(getAddress(v.receiver));
  });
});

describe("job admission", () => {
  it("accepts a receipt of its factory and names the predicted receiver; the same receipt again is the same job", async () => {
    const x = executor();
    const job = await x.add(request());
    expect(job.receiver).toBe(RECEIVER);
    expect(job.state).toBe("waiting-delivery");
    expect(await x.add(request())).toBe(job);
  });
  it("refuses another factory, a payload of another hash, a tip above 1 % of the minimum, a past deadline, no vault, a conflicting receipt", async () => {
    const x = executor();
    const code = async (r: ShieldJobRequest) =>
      x.add(r).then(
        () => "accepted",
        (e: ShieldJobError) => e.code,
      );
    expect(await code(request({ factory: "0x00000000000000000000000000000000000000f9" }))).toBe("unknown_factory");
    expect(await code(request({ noteData: ("0x01" + "cd".repeat(168)) as Hex }))).toBe("payload_mismatch");
    expect(await code(request({ noteData: "0x1234" }))).toBe("bad_payload");
    expect(await code(request({ params: { ...receiverParamsJson(params), shieldTip: (TIP + 1n).toString() } }))).toBe("bad_params");
    expect(await code(request({ deliverBy: 999 }))).toBe("bad_deadline");
    vaultOfAsset = "0x0000000000000000000000000000000000000000";
    expect(await code(request())).toBe("no_vault");
    vaultOfAsset = ETH_VAULT;
    await x.add(request());
    expect(await code(request({ params: { ...receiverParamsJson(params), noteSecret: "1" } }))).toBe("receipt_conflict");
  });
});

describe("the watch", () => {
  it("shields a delivery of at least the minimum once, and records the leaf, the deposit and the tip", async () => {
    const x = executor();
    await x.add(request());
    await x.tick();
    expect(raws).toHaveLength(0);
    receiverEth = 2_280_000_000_000_000_000n;
    await Promise.all([x.tick(), x.tick()]); // one pass at a time: the second waits and finds the shield sent
    expect(raws).toHaveLength(1);
    const sent = sentShield(raws[0]);
    expect(sent.functionName).toBe("deployAndShield");
    expect((sent.args as [{ receiptId: Hex }, Hex])[0].receiptId).toBe(params.receiptId);
    expect((sent.args as [unknown, Hex])[1]).toBe(NOTE_DATA);
    expect(x.get(params.receiptId)!.state).toBe("shielding");
    receipt = { status: "0x1", amount: receiverEth - TIP, tip: TIP, leafIndex: 42 };
    receiverEth = 0n;
    await x.tick();
    const job = x.get(params.receiptId)!;
    expect(job.state).toBe("shielded");
    expect(job.paid).toBe(true);
    expect(job.shields).toEqual([expect.objectContaining({ leafIndex: 42, amount: (2_280_000_000_000_000_000n - TIP).toString(), tip: TIP.toString() })]);
    expect(job.actualNetworkWei).toBe((400_000n * 1_000_000_000n).toString());
  });

  it("an ETH receipt waits while shielding costs more than its tip — until the swap is over", async () => {
    const x = executor();
    await x.add(request());
    receiverEth = 2_280_000_000_000_000_000n;
    gasPrice = 10_000_000_000n; // 10 gwei: 0.005 ETH, above the 0.002 tip
    await x.tick();
    expect(raws).toHaveLength(0);
    expect(x.get(params.receiptId)!.error).toMatch(/waiting: shielding now costs/);
    clock = 2_000; // deliverBy: the delivery is shielded anyway
    await x.tick();
    expect(raws).toHaveLength(1);
  });

  it("a smaller delivery waits for the swap to end, then is shielded without the tip, above its floor", async () => {
    const x = executor();
    await x.add(request());
    receiverEth = TIP * 50n; // half the minimum
    await x.tick();
    expect(raws).toHaveLength(0);
    clock = 2_000;
    await x.tick();
    expect(raws).toHaveLength(1);
    expect(x.get(params.receiptId)!.unpaidShields).toBe(1);
  });

  it("deliveries after the paid shield are bounded and floored; nothing pays for them", async () => {
    const x = executor({ maxUnpaidShields: 1 });
    await x.add(request());
    receiverEth = 2_280_000_000_000_000_000n;
    await x.tick();
    receipt = { status: "0x1", amount: receiverEth - TIP, tip: TIP, leafIndex: 7 };
    receiverEth = 0n;
    await x.tick();
    receipt = null;
    receiverEth = 500_000n * 1_000_000_000n; // exactly one gas cost: below the floor (twice the gas)
    await x.tick();
    expect(raws).toHaveLength(1);
    receiverEth = 10n ** 18n;
    deployed = true;
    tipPaid = true;
    await x.tick();
    expect(raws).toHaveLength(2);
    expect(x.get(params.receiptId)!.unpaidShields).toBe(1);
    receipt = { status: "0x1", amount: 10n ** 18n, tip: 0n, leafIndex: 9 };
    receiverEth = 0n;
    await x.tick();
    receipt = null;
    receiverEth = 10n ** 18n;
    await x.tick();
    expect(raws, "the budget of unpaid shields is used").toHaveLength(2);
    expect(x.get(params.receiptId)!.error).toMatch(/no tip pays for are used/);
  });

  it("somebody else claimed the tip: the delivery is shielded as an unpaid one", async () => {
    const x = executor();
    await x.add(request());
    deployed = true;
    tipPaid = true;
    receiverEth = 2_280_000_000_000_000_000n;
    await x.tick();
    expect(raws).toHaveLength(1);
    expect(x.get(params.receiptId)!.unpaidShields).toBe(1);
  });

  it("a receipt nothing reached expires after the watch; a shield that would revert fails without gas spent", async () => {
    const x = executor();
    await x.add(request());
    clock = 2_600;
    await x.tick();
    expect(x.get(params.receiptId)!.state).toBe("expired");
    const y = executor();
    clock = 1_000;
    await y.add(request());
    receiverEth = 2_280_000_000_000_000_000n;
    revertEstimate = true;
    await y.tick();
    expect(raws).toHaveLength(0);
    expect(y.get(params.receiptId)!.state).toBe("shield-failed");
    expect(y.get(params.receiptId)!.error).toMatch(/would revert/);
  });

  it("a shield the node dropped goes back DROP_AFTER_MS after it was sent and is shielded again; an unpaid one gives its place in the budget back (2026-10-15)", async () => {
    const x = executor();
    await x.add(request());
    receiverEth = TIP * 50n; // half the minimum: shielded without the tip once the swap is over
    clock = 2_000;
    await x.tick();
    const job = x.get(params.receiptId)!;
    expect(job.state).toBe("shielding");
    expect(job.unpaidShields).toBe(1);
    expect(job.sent).toEqual({ from: "waiting-delivery", at: 2_000, unpaid: true });
    dropped.add(job.txHash!);
    clock = 2_000 + DROP_AFTER_MS / 1000 - 1;
    await x.tick();
    expect(job.state, "not yet: the node may still take it").toBe("shielding");
    clock = 2_000 + DROP_AFTER_MS / 1000;
    await x.tick();
    expect(job.state).toBe("waiting-delivery");
    expect(job.unpaidShields).toBe(0);
    expect(job.error).toMatch(/^0x[0-9a-f]{64} was dropped before it was mined; shielded again$/);
    dropped.clear();
    await x.tick();
    expect(job.state).toBe("shielding");
    expect(raws).toHaveLength(2);
    expect(job.unpaidShields).toBe(1);
  });
});

describe("only a receipt the swap service vouched for (a V6 follow-up of 2026-10-16, audit gap 47)", () => {
  const code = (x: ShieldExecutor, r: ShieldJobRequest) =>
    x.add(r).then(
      () => "accepted",
      (e: ShieldJobError) => e.code,
    );
  it("shields a vouched receipt, never one without its vouch, with another key's or vouched for another receipt", async () => {
    const x = executor();
    expect(await code(x, request({ vouch: undefined })), "a receipt of anyone's own").toBe("unvouched_order");
    expect(await code(x, request({ vouch: vouchFor(request(), new Uint8Array(32).fill(0x5b)) })), "another key's").toBe("unvouched_order");
    const other = request({ params: { ...receiverParamsJson(params), receiptId: ("0x" + "6f".repeat(32)) as Hex } });
    expect(await code(x, request({ vouch: other.vouch })), "the vouch of another receipt").toBe("unvouched_order");
    expect(x.list(), "nothing watched").toHaveLength(0);
    expect(await code(x, request())).toBe("accepted");
  });
  it("an executor without the swap service's address shields nothing; the server answers 503 without it", async () => {
    expect(await code(executor({ voucher: undefined }), request())).toBe("shield_unavailable");
    const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts"), "utf8");
    expect(server).toMatch(/if \(!shields \|\| !apiVoucher\) return send\(503/);
    expect(server).toMatch(/chainId: cfg\.chainId, \.\.\.\(apiVoucher \? \{ voucher: apiVoucher \} : \{\}\)/);
  });
  it("while the swap service rotates its key, a receipt the former key vouched for is shielded as long as its address is listed", async () => {
    const former = new Uint8Array(32).fill(0x5d);
    const formerVouch = vouchFor(request(), former);
    expect(await code(executor({ voucher: [VOUCHER, orderSignerAddress(former)] }), request({ vouch: formerVouch }))).toBe("accepted");
    expect(await code(executor(), request({ vouch: formerVouch })), "the former address dropped").toBe("unvouched_order");
    expect(await code(executor({ voucher: [] }), request()), "an empty list: nothing").toBe("shield_unavailable");
  });
});
