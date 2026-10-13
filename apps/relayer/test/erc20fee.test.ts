// Fee notes in ERC-20 vaults (plan §36: private USDC / USDT): a transaction is single-asset, so a
// USDC withdrawal pays its relayer in USDC. The relayer accepts configured vaults with a fixed
// minimum, refuses unknown vaults, under-payment and payloads that do not open with its view key,
// and keeps pricing the ETH vault live. Synthetic request (the proof is never checked locally; the
// simulation gate is mocked), no funds.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { createPublicClient, createWalletClient, http, keccak256, type Hex } from "viem";
import { utf8ToBytes } from "@noble/hashes/utils";
import { privateKeyToAccount } from "viem/accounts";
import { Relayer, relayerIdentity, type RelayerConfig, type SubmitRequest } from "../src/relayer";
import { encryptNoteData } from "@privacy-wallet/protocol/envelope";
import { noteBody } from "@privacy-wallet/protocol/note";
import { noteDataHash, txDomain } from "@privacy-wallet/protocol/payload";

const CORE = "0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9";
const ETH_VAULT = "0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469";
const USDC_VAULT = "0x00000000000000000000000000000000000ca5de";
const USDT_VAULT = "0x0000000000000000000000000000000000007e7e";
const seed = utf8ToBytes("relayer-erc20-fee-test");
const toHex = (b: Uint8Array): Hex => ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;
const hexToBytes = (h: Hex) => Uint8Array.from(h.slice(2).match(/../g)!.map((x) => parseInt(x, 16)));

let server: Server;
let relayer: Relayer;
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const handle = (r: { id: number; method: string; params: any[] }) => {
        const ok = (result: unknown) => ({ jsonrpc: "2.0", id: r.id, result });
        switch (r.method) {
          case "eth_chainId": return ok("0x7a69");
          case "eth_gasPrice": return ok("0x3b9aca00");
          case "eth_estimateGas": return ok("0x1b7740");
          case "eth_getTransactionCount": return ok("0x1");
          case "eth_maxPriorityFeePerGas": return ok("0x3b9aca00");
          case "eth_getBlockByNumber": return ok({ number: "0x10", hash: "0x" + "11".repeat(32), parentHash: "0x" + "00".repeat(32), nonce: "0x0000000000000000", sha3Uncles: "0x" + "00".repeat(32), logsBloom: "0x" + "00".repeat(256), transactionsRoot: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), miner: "0x" + "00".repeat(20), difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x1", baseFeePerGas: "0x3b9aca00", mixHash: "0x" + "00".repeat(32), transactions: [], uncles: [] });
          case "eth_sendRawTransaction": return ok(keccak256(r.params[0]));
          default: return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `mock: ${r.method}` } };
        }
      };
      const j = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(j) ? j.map(handle) : handle(j)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const rpcUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cfg: RelayerConfig = {
    chainId: 31337, core: CORE, feeVault: ETH_VAULT, feeVaults: { [USDC_VAULT.toLowerCase()]: { symbol: "USDC", decimals: 6, minFee: 2_000_000n } },
    minFeeWei: 0n, gasEstimate: 1_800_000n, feeMarginBps: 2000, privateKey: ("0x" + "77".repeat(32)) as Hex, masterSeed: seed, rpcUrl, requireReadableFeePayload: true,
  };
  const chain = { id: 31337, name: "mock", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as const;
  const transport = http(rpcUrl, { batch: true });
  relayer = new Relayer(cfg, { publicClient: createPublicClient({ chain, transport }), walletClient: createWalletClient({ account: privateKeyToAccount(cfg.privateKey), chain, transport }) });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** A synthetic transact whose output 2 is a fee note of `amount` in `vault` to the relayer, payload encrypted to its view key. */
let seq = 0n;
function request(vault: Hex, amount: bigint, opts: { payloadVault?: Hex } = {}): SubmitRequest {
  seq += 2n; // fresh nullifiers per request: the relayer refuses a note already in flight
  const id = relayerIdentity(seed);
  const secret = 424242n;
  const feeBody = noteBody({ vaultId: BigInt(vault), amount, ownerCommitment: id.ownerCommitment, noteSecret: secret });
  const payloads: [Hex, Hex, Hex] = [
    toHex(encryptNoteData(id.view.publicKey, { amount: 1n, noteSecret: 2n, vaultId: 3n })),
    toHex(encryptNoteData(id.view.publicKey, { amount: 4n, noteSecret: 5n, vaultId: 6n })),
    toHex(encryptNoteData(id.view.publicKey, { amount, noteSecret: secret, vaultId: BigInt(opts.payloadVault ?? vault) })),
  ];
  const pi = [1n, 11n + seq, 12n + seq, 21n, 22n, feeBody, 1n, BigInt(vault), 1_000_000n, 0xb0bn, ...payloads.map((p) => noteDataHash(hexToBytes(p))), txDomain(31337n, BigInt(CORE))];
  return { proof: ("0x" + "11".repeat(256)) as Hex, publicInputs: pi.map(String), noteData: payloads, fee: { outputIndex: 2, amount: amount.toString(), noteSecret: secret.toString(), vault } };
}

describe("ERC-20 fee vaults", () => {
  it("advertises the accepted vaults with their fixed minimums next to the live ETH minimum", async () => {
    const info = await relayer.info();
    expect(info.feeVaults).toEqual([{ vault: USDC_VAULT.toLowerCase(), symbol: "USDC", decimals: 6, minFee: "2000000" }]);
    expect(BigInt(info.minFeeWei)).toBe((1_800_000n * 1_000_000_000n * 12_000n) / 10_000n);
  });
  it("accepts a USDC fee note at or above the minimum and records the vault", async () => {
    const r = await relayer.submit(request(USDC_VAULT, 2_000_000n));
    expect(r.feeVault.toLowerCase()).toBe(USDC_VAULT.toLowerCase());
    expect(r.feeWei).toBe("2000000");
    expect(r.feePayloadReadable).toBe(true);
    expect(relayer.jobs_().some((j) => j.feeVault.toLowerCase() === USDC_VAULT.toLowerCase())).toBe(true);
  });
  it("refuses under-payment in USDC, an unknown vault, and a payload that names another vault", async () => {
    await expect(relayer.submit(request(USDC_VAULT, 1_999_999n))).rejects.toMatchObject({ code: "fee_too_low" });
    await expect(relayer.submit(request(USDT_VAULT, 10_000_000n))).rejects.toMatchObject({ code: "fee_vault_not_accepted" });
    await expect(relayer.submit(request(USDC_VAULT, 2_000_000n, { payloadVault: ETH_VAULT }))).rejects.toMatchObject({ code: "fee_payload_unreadable" });
    const wrongBody = request(USDC_VAULT, 2_000_000n);
    wrongBody.fee.vault = ETH_VAULT; // the note was built for the USDC vault
    await expect(relayer.submit(wrongBody)).rejects.toMatchObject({ code: "fee_note_mismatch" });
  });
  it("still prices the ETH vault live (a fee opening without a vault means the ETH vault)", async () => {
    const minWei = (await relayer.minFeeWei()).minFeeWei;
    const req = request(ETH_VAULT, minWei);
    delete req.fee.vault;
    const r = await relayer.submit(req);
    expect(r.feeVault).toBe(ETH_VAULT);
    expect(await relayer.minFeeIn({})).toBe(minWei);
    expect(await relayer.minFeeIn({ vault: USDC_VAULT })).toBe(2_000_000n);
  });
});
