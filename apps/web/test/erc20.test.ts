// Private ERC-20 assets (plan §36) and relayer failover (plan §85 rule 5): the deployment's asset
// list, the per-asset bucket alphabet, the exact-amount approval, the per-vault relayer fee terms
// (live for ETH, the relayer's fixed minimum for an ERC-20 vault, a clear refusal otherwise), the
// fallback to the next relayer when the first is unreachable, and a USDC withdrawal plan whose fee
// note lives in the USDC vault. Mock relayers on loopback; no chain, no funds.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { decodeFunctionData, type Address } from "viem";
import { utf8ToBytes } from "@noble/hashes/utils";
import { BUCKETS, bucketsFor, isBucketOf } from "@privacy-wallet/protocol/wallet/amounts";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { MerkleTree } from "@privacy-wallet/protocol/merkle";
import { TX_LEVELS, buildTxInputs } from "@privacy-wallet/protocol/txInputs";
import { txDomain } from "@privacy-wallet/protocol/payload";
import { viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { assetsOf, bucketBelowFor, isBucketFor, parseAmount, parseErc20Vaults } from "@privacy-wallet/sdk/assets";
import { buildApprove, erc20Abi } from "@privacy-wallet/sdk/privacyProtocol";
import { feeTerms, planWithdrawal, placeholderNoteData } from "@privacy-wallet/sdk/privateTx";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import type { RelayerInfo } from "@privacy-wallet/sdk/relayer";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";

const CORE = "0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9" as Address;
const ETH_VAULT = "0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const USDC_VAULT = "0x00000000000000000000000000000000000ca5de" as Address;
const USDT_VAULT = "0x0000000000000000000000000000000000007e7e" as Address;
const spec = `USDC:${USDC}:${USDC_VAULT}:6,USDT:0xdAC17F958D2ee523a2206206994597C13D831ec7:${USDT_VAULT}:6`;
const deployment: Deployment = { chainId: 31337, core: CORE, ethVault: ETH_VAULT, rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: parseErc20Vaults(spec) };

const info: RelayerInfo = {
  chainId: 31337, core: CORE, feeVault: ETH_VAULT, relayer: "0x000000000000000000000000000000000000beef", privacyAddress: "",
  minFeeWei: "2160000000000000", gasPriceWei: "1000000000", gasEstimate: "1800000", feeMarginBps: 2000, requireReadableFeePayload: true, inflight: 0,
  feeVaults: [{ vault: USDC_VAULT, symbol: "USDC", decimals: 6, minFee: "2000000" }],
};
let server: Server;
let live: string;
const dead = "http://127.0.0.1:9/";

beforeAll(async () => {
  const { encodePrivacyAddress } = await import("@privacy-wallet/protocol/address");
  const { viewKeyPair } = await import("@privacy-wallet/protocol/envelope");
  const k = deriveKeys(utf8ToBytes("privacy-protocol/example-relayer"));
  info.privacyAddress = encodePrivacyAddress(ownerCommitmentOf(k.spendKey), viewKeyPair(k.viewKey).publicKey);
  server = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(req.url === "/info" ? JSON.stringify(info) : JSON.stringify({ error: "not found" })); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  live = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("assets", () => {
  it("parses the deployment's ERC-20 vaults and refuses malformed entries", () => {
    const assets = assetsOf(deployment);
    expect(assets.map((a) => a.symbol)).toEqual(["ETH", "USDC", "USDT"]);
    expect(assets[1]).toEqual({ symbol: "USDC", token: USDC, vault: USDC_VAULT, decimals: 6 });
    expect(() => parseErc20Vaults("USDC:notanaddress:0x00:6")).toThrow(/SYMBOL:0xtoken:0xvault:decimals/);
    expect(assetsOf(null)[0].symbol).toBe("ETH");
  });
  it("gives every asset a bucket alphabet in its own decimals", () => {
    expect(bucketsFor(18)).toBe(BUCKETS);
    const usdc = bucketsFor(6);
    expect(usdc[0]).toBe(1_000_000n); // 1 USDC
    expect(usdc.slice(0, 4)).toEqual([1_000_000n, 2_000_000n, 5_000_000n, 10_000_000n]);
    expect(isBucketOf(200_000_000n, 6)).toBe(true);
    expect(isBucketOf(123_000_000n, 6)).toBe(false);
    const a = assetsOf(deployment)[1];
    expect(parseAmount(a, "123.5")).toBe(123_500_000n);
    expect(bucketBelowFor(a, 123_500_000n)).toBe(100_000_000n);
    expect(isBucketFor(a, 100_000_000n)).toBe(true);
  });
  it("builds an exact-amount approval for the token's vault", () => {
    const tx = buildApprove(USDC, USDC_VAULT, 250_000_000n);
    expect(tx.to).toBe(USDC);
    const d = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(d.functionName).toBe("approve");
    expect(String((d.args as any)[0]).toLowerCase()).toBe(USDC_VAULT.toLowerCase());
    expect((d.args as any)[1]).toBe(250_000_000n);
  });
});

describe("per-vault fee terms and relayer failover", () => {
  it("prices the ETH vault live and an ERC-20 vault from the relayer's fixed minimum (+10 %)", async () => {
    const eth = await feeTerms(deployment, { kind: "relayer", url: live }, ETH_VAULT, []);
    expect(eth!.fee.amount).toBe((2_160_000_000_000_000n * 11_000n) / 10_000n);
    expect(eth!.fee.vault).toBe(BigInt(ETH_VAULT));
    const usdc = await feeTerms(deployment, { kind: "relayer", url: live }, USDC_VAULT, []);
    expect(usdc!.fee.amount).toBe(2_200_000n);
    expect(usdc!.fee.vault).toBe(BigInt(USDC_VAULT));
    expect(usdc!.url).toBe(live);
    expect(await feeTerms(deployment, { kind: "wallet" }, USDC_VAULT, [])).toBeNull();
  });
  it("refuses honestly when no relayer takes fees in the asset", async () => {
    await expect(feeTerms(deployment, { kind: "relayer", url: live }, USDT_VAULT, [])).rejects.toThrow(/no relayer available for this asset.*takes no fees in vault/);
  });
  it("falls back to the next relayer when the configured one is unreachable (rule 5)", async () => {
    const t = await feeTerms(deployment, { kind: "relayer", url: dead }, USDC_VAULT, [live]);
    expect(t!.url).toBe(live);
    await expect(feeTerms(deployment, { kind: "relayer", url: dead }, USDC_VAULT, [dead])).rejects.toThrow(/unreachable/);
  });
});

describe("a USDC withdrawal plan", () => {
  const seed = utf8ToBytes("frontend-erc20-plan-seed");
  const keys = deriveKeys(seed);
  const oc = ownerCommitmentOf(keys.spendKey);
  beforeEach(() => noteStore.clear());

  it("spends a USDC note, pays the relayer in USDC and keeps the change in the USDC vault", () => {
    const vaultId = BigInt(USDC_VAULT);
    const note: Note = { vaultId, amount: 500_000_000n, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, 0) };
    const tree = new MerkleTree(TX_LEVELS);
    tree.insertLeaf(noteCommitment(noteBody(note), 0n));
    noteStore.add({ note, leafIndex: 0, noteData: placeholderNoteData(), counter: 0, spent: false, label: "shield" });
    const relayerKeys = deriveKeys(utf8ToBytes("privacy-protocol/example-relayer"));
    const fee = { ownerCommitment: ownerCommitmentOf(relayerKeys.spendKey), viewPub: viewKeyPair(relayerKeys.viewKey).publicKey, amount: 2_200_000n, vault: vaultId };
    const plan = planWithdrawal(seed, tree.leaves, vaultId, 200_000_000n, 0xb0bn, txDomain(31337n, BigInt(CORE)), fee);
    expect(plan.spec.withdrawal).toEqual({ vault: vaultId, amount: 200_000_000n, recipient: 0xb0bn });
    expect(plan.fee!.note.vaultId).toBe(vaultId);
    expect(plan.fee!.note.amount).toBe(2_200_000n);
    expect(plan.fee!.note.ownerCommitment).toBe(fee.ownerCommitment);
    expect(plan.change!.note.vaultId).toBe(vaultId);
    expect(plan.change!.note.amount).toBe(500_000_000n - 200_000_000n - 2_200_000n);
    const inputs = buildTxInputs(plan.spec); // value conserved inside one vault, every note opens its leaf
    expect(inputs.withdrawalVault).toBe(vaultId.toString());
  });
});
