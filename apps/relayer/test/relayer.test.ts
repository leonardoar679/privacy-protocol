// The relayer against the forge-verified e2e transaction (contracts/test/e2e/E2EFixture.sol, tx 0:
// Alice's withdrawal paying a 0.05 ETH private fee note to the relayer whose seed the fixture uses)
// on a local mock JSON-RPC server: every local check, the simulation gate, the submission from the
// relayer's own key, in-flight nullifier protection and status tracking; a broadcast's fate read from the node (a V6
// follow-up of 2026-10-15). No real chain, no funds.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, keccak256, parseTransaction, recoverTransactionAddress, toHex, type Hex } from "viem";
import { utf8ToBytes } from "@noble/hashes/utils";
import { privateKeyToAccount } from "viem/accounts";
import { Relayer, RelayerError, relayerIdentity, type RelayerConfig, type SubmitRequest } from "../src/relayer";
import { decodeTransact, encodeTransact, piFromStrings } from "../src/abi";
import { encryptNoteData } from "@privacy-wallet/protocol/envelope";
import { noteBody } from "@privacy-wallet/protocol/note";
import { noteDataHash } from "@privacy-wallet/protocol/payload";
import { FIXTURE_ROOT, fixtureRequest, have } from "./fixture";

const root = FIXTURE_ROOT;

// ---- mock JSON-RPC ----
const raws: Hex[] = [];
let revertSimulation = false;
let receiptStatus: "0x1" | "0x0" | null = null;
let sendMode: "take" | "refuse" | "lose-answer" = "take";
let lost = false; // the node took the transaction and the answer is lost on the way back (a proxy's 502)
const taken = new Set<Hex>();
const block = { number: "0x10", hash: "0x" + "11".repeat(32), parentHash: "0x" + "00".repeat(32), nonce: "0x0000000000000000", sha3Uncles: "0x" + "00".repeat(32), logsBloom: "0x" + "00".repeat(256), transactionsRoot: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), miner: "0x" + "00".repeat(20), difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x1", baseFeePerGas: "0x3b9aca00", mixHash: "0x" + "00".repeat(32), transactions: [], uncles: [] };
function handle(req: { id: number; method: string; params: any[] }) {
  const res = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  switch (req.method) {
    case "eth_chainId": return res("0x7a69");
    case "eth_blockNumber": return res("0x10");
    case "eth_getBlockByNumber": return res(block);
    case "eth_gasPrice": return res("0x3b9aca00"); // 1 gwei
    case "eth_maxPriorityFeePerGas": return res("0x3b9aca00");
    case "eth_getTransactionCount": return res("0x3");
    case "eth_estimateGas": return revertSimulation ? { jsonrpc: "2.0", id: req.id, error: { code: 3, message: "execution reverted: UnknownRoot()" } } : res("0x1b7740");
    case "eth_sendRawTransaction": {
      if (sendMode === "refuse") return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "nonce too low" } };
      const h = keccak256(req.params[0]);
      if (taken.has(h)) return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "already known" } };
      raws.push(req.params[0]); taken.add(h);
      if (sendMode === "lose-answer") { sendMode = "take"; lost = true; }
      return res(h);
    }
    case "eth_getTransactionByHash": return res(taken.has(req.params[0]) ? { hash: req.params[0], nonce: "0x1", from: "0x" + "00".repeat(20), to: "0x" + "00".repeat(20), input: "0x", value: "0x0", gas: "0x5208", blockHash: null, blockNumber: null, transactionIndex: null, type: "0x2", chainId: "0x7a69", maxFeePerGas: "0x77359400", maxPriorityFeePerGas: "0x3b9aca00", v: "0x0", yParity: "0x0", r: "0x1", s: "0x1" } : null);
    case "eth_getTransactionReceipt": return res(receiptStatus === null ? null : { transactionHash: req.params[0], status: receiptStatus, blockNumber: "0x11", blockHash: "0x" + "11".repeat(32), transactionIndex: "0x0", from: "0x" + "00".repeat(20), to: "0x" + "00".repeat(20), cumulativeGasUsed: "0x1b7740", gasUsed: "0x1b7740", effectiveGasPrice: "0x3b9aca00", logs: [], logsBloom: "0x" + "00".repeat(256), type: "0x2" });
    default: return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `mock rpc: ${req.method} unsupported` } };
  }
}

let server: Server;
let relayer: Relayer;
let cfg: RelayerConfig;
const RELAYER_SEED = utf8ToBytes("privacy-protocol/example-relayer"); // the fixture's relayer
const RELAYER_KEY = ("0x" + "5e".repeat(32)) as Hex;

beforeAll(async () => {
  server = createServer((req, res) => { let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => { const j = JSON.parse(body); const out = JSON.stringify(Array.isArray(j) ? j.map(handle) : handle(j)); if (lost) { lost = false; res.statusCode = 502; return res.end("bad gateway"); } res.setHeader("content-type", "application/json"); res.end(out); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const rpcUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { deployment } = have ? fixtureRequest() : { deployment: { core: "0x" + "01".repeat(20), vault: "0x" + "02".repeat(20), chainId: 31337 } };
  cfg = { chainId: Number(deployment.chainId), core: deployment.core, feeVault: deployment.vault, minFeeWei: 0n, gasEstimate: 1_800_000n, feeMarginBps: 2000, privateKey: RELAYER_KEY, masterSeed: RELAYER_SEED, rpcUrl, requireReadableFeePayload: false };
  const chain = { id: cfg.chainId, name: "test", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as const;
  const transport = http(rpcUrl, { batch: true });
  relayer = new Relayer(cfg, { publicClient: createPublicClient({ chain, transport }), walletClient: createWalletClient({ account: privateKeyToAccount(RELAYER_KEY), chain, transport }) });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("identity", () => {
  it("the fee note in the forge e2e fixture is addressed to this relayer's owner commitment", () => {
    if (!have) return;
    const tx1 = JSON.parse(readFileSync(join(root, "circuits/test/fixtures/e2e/tx1.json"), "utf8"));
    expect(relayerIdentity(RELAYER_SEED).ownerCommitment.toString()).toBe(tx1.outOwnerCommitment[1]);
    expect(relayer.identity.privacyAddress.startsWith("pp1")).toBe(true);
  });
  it("info exposes the live minimum fee: gas × price × (1 + margin)", async () => {
    const i = await relayer.info();
    expect(BigInt(i.minFeeWei)).toBe((1_800_000n * 1_000_000_000n * 12_000n) / 10_000n);
    expect(i.relayer).toBe(relayer.account.address);
  });
});

describe.skipIf(!have)("submission of the forge-verified transaction", () => {
  it("accepts the fixture: simulates, signs from its own key and broadcasts an exact transact call", async () => {
    const { req } = fixtureRequest();
    const r = await relayer.submit(req);
    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(r.feeWei)).toBe(50_000_000_000_000_000n);
    expect(r.feePayloadReadable).toBe(false); // the fixture's payloads are test bytes, not encrypted to the relayer
    expect(raws.length).toBe(1);
    const tx = parseTransaction(raws[0]);
    expect(tx.to?.toLowerCase()).toBe(cfg.core.toLowerCase());
    expect(tx.chainId).toBe(cfg.chainId);
    expect((await recoverTransactionAddress({ serializedTransaction: raws[0] as `0x02${string}` })).toLowerCase()).toBe(relayer.account.address.toLowerCase());
    const d = decodeTransact(tx.data!);
    expect(d.proof).toBe(req.proof);
    expect(d.noteData).toEqual(req.noteData);
    expect(d.pi).toEqual(piFromStrings(req.publicInputs));
    expect(tx.data).toBe(encodeTransact(req.proof, piFromStrings(req.publicInputs), req.noteData));
  });
  it("refuses the same nullifiers while in flight, then tracks the receipt and frees them", async () => {
    const { req } = fixtureRequest();
    await expect(relayer.submit(req)).rejects.toMatchObject({ code: "nullifier_in_flight" });
    const hash = raws[0] && keccak256(raws[0]);
    receiptStatus = "0x1";
    const s = await relayer.status(hash);
    expect(s?.status).toBe("mined");
    expect(s?.gasUsed, "V6 (spec v2.0 §3): the receipt's gas").toBe("1800000");
    expect(s?.actualNetworkWei, "gasUsed × effectiveGasPrice: 1.8M × 1 gwei").toBe("1800000000000000");
    receiptStatus = null;
    expect((await relayer.info()).inflight).toBe(0);
  });
  it("rejects a fee below the live minimum, a fee opening that is not its note, a tampered payload, the wrong chain", async () => {
    const { req } = fixtureRequest();
    const big = new Relayer({ ...cfg, minFeeWei: 10n ** 18n }, relayer.clients);
    await expect(big.submit(req)).rejects.toMatchObject({ code: "fee_too_low" });
    expect(() => relayer.validateShape({ ...req, fee: { ...req.fee, amount: (BigInt(req.fee.amount) + 1n).toString() } })).toThrow(RelayerError);
    expect(() => relayer.validateShape({ ...req, fee: { ...req.fee, outputIndex: 0 } })).toThrow(/not a note of/);
    const tampered: [Hex, Hex, Hex] = [req.noteData[0], (req.noteData[1].slice(0, -2) + "00") as Hex, req.noteData[2]];
    expect(() => relayer.validateShape({ ...req, noteData: tampered })).toThrow(/does not hash/);
    const otherChain = new Relayer({ ...cfg, chainId: 1 }, relayer.clients);
    expect(() => otherChain.validateShape(req)).toThrow(/txDomain/);
    const otherRelayer = new Relayer({ ...cfg, masterSeed: utf8ToBytes("not the fixture's relayer") }, relayer.clients);
    expect(() => otherRelayer.validateShape(req)).toThrow(/not a note of/);
  });
  it("spends no gas on a transaction that would revert (simulation gate)", async () => {
    const { req } = fixtureRequest();
    revertSimulation = true;
    try {
      const before = raws.length;
      await expect(relayer.submit(req)).rejects.toMatchObject({ code: "simulation_failed" });
      expect(raws.length).toBe(before);
      expect((await relayer.info()).inflight).toBe(0);
    } finally {
      revertSimulation = false;
    }
  });
  it("requireReadableFeePayload: a fee whose payload is encrypted to the relayer's view key passes the readability check", () => {
    const { req } = fixtureRequest();
    const strict = new Relayer({ ...cfg, requireReadableFeePayload: true }, relayer.clients);
    expect(() => strict.validateShape(req)).toThrow(/not encrypted to this relayer/);
    // what the wallet will do: encrypt the fee opening to the relayer; the proof then commits to that payload's hash
    const amount = BigInt(req.fee.amount), noteSecret = BigInt(req.fee.noteSecret);
    const payload = encryptNoteData(relayer.identity.view.publicKey, { amount, noteSecret, vaultId: BigInt(cfg.feeVault) });
    const hex = ("0x" + Array.from(payload, (b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
    const pi = piFromStrings(req.publicInputs);
    const adjusted = { ...req, noteData: [req.noteData[0], hex, req.noteData[2]] as [Hex, Hex, Hex], publicInputs: req.publicInputs.map((v, i) => (i === 11 ? noteDataHash(payload).toString() : v)) };
    expect(noteBody({ vaultId: BigInt(cfg.feeVault), amount, ownerCommitment: relayer.identity.ownerCommitment, noteSecret })).toBe(pi.outputBody1);
    const v = strict.validateShape(adjusted); // (the proof would no longer verify on chain: this checks the relayer's local logic only)
    expect(v.feePayloadReadable).toBe(true);
    expect(v.feeWei).toBe(amount);
  });
  it("a broadcast whose answer was lost, the node holding it, is submitted and its hash answered; it was send_failed (2026-10-15)", async () => {
    const { req } = fixtureRequest();
    taken.clear();
    sendMode = "lose-answer";
    const r = await relayer.submit(req);
    expect(taken.has(r.txHash)).toBe(true);
    expect(relayer.jobByNullifier(String(piFromStrings(req.publicInputs).nullifier0))).toEqual({ txHash: r.txHash, status: "submitted" });
    receiptStatus = "0x1";
    await relayer.status(r.txHash); // mined: its notes leave in flight
    receiptStatus = null;
  });
  it("a broadcast the node refused and does not know is send_failed in the node's words, and its notes are free again", async () => {
    const { req } = fixtureRequest();
    taken.clear();
    sendMode = "refuse";
    try {
      await expect(relayer.submit(req)).rejects.toMatchObject({ code: "send_failed", message: expect.stringMatching(/nonce too low/) });
      expect((await relayer.info()).inflight).toBe(0);
    } finally {
      sendMode = "take";
    }
  });
});

describe("shape validation without a fixture", () => {
  it("rejects malformed requests with specific codes", () => {
    const bad = (r: any) => { try { relayer.validateShape(r); return "ok"; } catch (e) { return (e as RelayerError).code; } };
    expect(bad({})).toBe("bad_proof");
    expect(bad({ proof: "0x" + "00".repeat(256) })).toBe("bad_public_inputs");
    expect(bad({ proof: "0x" + "00".repeat(256), publicInputs: Array(14).fill("1"), noteData: ["0x00"] })).toBe("bad_payloads");
    expect(bad({ proof: "0x" + "00".repeat(256), publicInputs: Array(14).fill("1"), noteData: Array(3).fill("0x" + "00".repeat(169)) })).toBe("wrong_domain");
    expect(toHex(1)).toBe("0x1");
  });
});
