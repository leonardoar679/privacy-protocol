// WalletConnect's Protect since F11-10, end to end over the real code (the eleventh review round's critique of the fix): its deposit's receipt
// cannot be read, the flow ends deposit_unconfirmed, the record is left as ProtectScreen leaves it (engineListener, then recovery-required),
// and the real scan of the pool records the note at once — never held for finality, which on mainnet takes half an hour, since its record
// awaits it — and its stale pass completes the Protect at the note's leaf; no request names the deposit's hash. A note of this wallet that
// no record awaits still waits for the proof that covers its leaf (audit round 2, r24; the third review round).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import { MerkleTree, ZERO_LEAF } from "@privacy-wallet/protocol/merkle";
import { TX_LEVELS } from "@privacy-wallet/protocol/txInputs";
import { noteBody, noteCommitment } from "@privacy-wallet/protocol/note";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { useCoreModule } from "../src/core";
import { prepareShield, submitShield } from "../src/privateTx";
import { walletReceiptTiming, type Deployment } from "../src/chain";
import { DISCOVERY_ID, DISCOVERY_MIN_GAP_MS, runDiscovery } from "../src/wallet/discovery";
import { noteStore } from "../src/wallet/notes";
import { applyEvent, getOperation, newOperation } from "../src/operations/store";
import { engineListener } from "../src/operations/engineEvents";
import { classify } from "../src/operations/errors/catalog";
import { startPool } from "./helpers/mockPool";

// mainnet's light client: the pool proven at the latest finalized block holds `proven` leaves
const lc = vi.hoisted(() => ({ proven: 0 }));
vi.mock("../src/verifiedReads", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  verifyTree: async () => ({ kind: "verified", proof: { blockNumber: 100n, slot: 1, nextLeafIndex: lc.proven, root: 0n }, leaves: lc.proven }),
  provenSpent: async (_d: unknown, nfs: bigint[]) => (nfs.length ? { blockNumber: 100n, blocks: nfs.map(() => 100n), spent: nfs.map(() => false) } : null),
}));
const w = vi.hoisted(() => ({
  provider: null as null | { isWalletConnect?: boolean; request: (a: { method: string; params?: unknown[] }) => Promise<unknown> },
}));
vi.mock("@privacy-wallet/wallet-engine/injected", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/wallet-engine/injected")>()),
  activeProvider: () => w.provider,
  connectedProvider: () => w.provider,
}));
vi.mock("../src/deploymentGuard", () => ({ guardDeployment: async () => undefined }));

const CORE = getAddress("0x5991a2df15a8f6a256d3ec51e99254cd3fb576a9");
const VAULT = getAddress("0x36ffa23fd38ae93e2b01aa5fa1570845ada89469");
const ACCOUNT = "0x00000000000000000000000000000000000000b0";
const rootOf = (leaves: Map<number, bigint>, next: number) => {
  const t = new MerkleTree(TX_LEVELS);
  for (let g = 0; g < next; g += 4) t.insertGroup([0, 1, 2, 3].map((k) => leaves.get(g + k) ?? ZERO_LEAF));
  return t.root;
};
let pool: Awaited<ReturnType<typeof startPool>>;
const d = (): Deployment => ({ chainId: 1, core: CORE, ethVault: VAULT, rpcUrl: pool.url, rpcUrls: [pool.url], fromBlock: 0n, erc20Vaults: [] });
const timing = { ...walletReceiptTiming };
beforeAll(async () => {
  configure(defaultConfig({ kdfLog2N: 12, storage: () => memoryStorage() }));
  await session.create("a strong password");
  session.acknowledgePhrase();
  walletReceiptTiming.timeoutMs = 300;
  walletReceiptTiming.intervalMs = 5;
  pool = await startPool({ core: CORE, inserts: [], next: 0, root: rootOf(new Map(), 0) });
});
afterAll(async () => {
  Object.assign(walletReceiptTiming, timing);
  w.provider = null;
  await pool.close();
});

describe("a WalletConnect Protect, its deposit past the proven pool (the critique of F11-10)", () => {
  it("the scan records the note its record awaits at once, and its stale pass completes the Protect; the pool never hears the deposit's hash", async () => {
    useCoreModule(null);
    const seed = session.state().seed!;
    const p = prepareShield({ masterSeed: seed, deployment: d(), amount: 10n ** 17n });
    const H = ("0x" + "ab".repeat(32)) as Hex;
    const commitment = noteCommitment(noteBody(p.note), 0n);
    w.provider = {
      isWalletConnect: true,
      request: async ({ method }) => {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [ACCOUNT];
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_sendTransaction") {
          // mined at once, at leaf 0 — past the pool the light client proves (none of it yet)
          pool.state.inserts = [{ leafIndex: 0, commitment, noteData: p.noteData, txHash: H }];
          pool.state.next = 4;
          pool.state.root = rootOf(new Map([[0, commitment]]), 4);
          return H;
        }
        throw new Error("Failed to fetch"); // WalletConnect's reads, under the policy
      },
    };
    const rec = newOperation({
      kind: "protect",
      amounts: { asset: "ETH", decimals: 18, input: (10n ** 17n).toString() },
      destination: { kind: "privacy-address", display: "protected-balance", chain: "ethereum" },
      tier: "standard",
    } as never);
    applyEvent(rec.id, { type: "review" });
    applyEvent(rec.id, { type: "confirm" });
    const onEvent = engineListener((ev) => {
      applyEvent(rec.id, ev);
    });
    const err = await submitShield(p, { onEvent, account: ACCOUNT }).then(
      () => null,
      (e: unknown) => e,
    );
    const c = classify(err);
    expect(c.code).toBe("deposit_unconfirmed");
    applyEvent(rec.id, { type: "recovery-required", code: c.code, detail: c.detail });
    expect(getOperation(rec.id)?.refs, "the record keeps the note's counter and the sending account").toMatchObject({
      noteCounter: p.counter,
      sender: ACCOUNT,
    });
    const action = { id: DISCOVERY_ID, kind: "discovery", orderId: "pool", dueAt: Date.now() } as never;
    const before = Date.now();
    await runDiscovery(action, { masterSeed: seed, deployment: d(), session });
    expect(getOperation(rec.id)).toMatchObject({ state: "COMPLETED", refs: { leafIndex: 0 } });
    expect(
      noteStore.all().map((n) => n.leafIndex),
      "in the balance",
    ).toEqual([0]);
    expect(
      pool.state.log.filter((l) => JSON.stringify(l.params).toLowerCase().includes("ab".repeat(32))).map((l) => l.method),
      "the pool never hears the deposit's hash",
    ).toEqual([]);
    // nothing awaited any more: the next scan at the interval, not each minute
    const next = session.journal().schedule.find((a) => a.id === DISCOVERY_ID && !a.done);
    expect(next!.dueAt - before, "the interval").toBeGreaterThan(DISCOVERY_MIN_GAP_MS);
  });

  it("a note of this wallet that no record awaits waits for the proof that covers its leaf — the exception is the record's own note alone", async () => {
    const seed = session.state().seed!;
    const p2 = prepareShield({ masterSeed: seed, deployment: d(), amount: 2n * 10n ** 17n });
    const c2 = noteCommitment(noteBody(p2.note), 1n);
    const c0 = pool.state.inserts[0].commitment;
    pool.state.inserts = [...pool.state.inserts, { leafIndex: 1, commitment: c2, noteData: p2.noteData, txHash: ("0x" + "cd".repeat(32)) as Hex }];
    pool.state.root = rootOf(
      new Map([
        [0, c0],
        [1, c2],
      ]),
      4,
    );
    lc.proven = 1; // leaf 0 proven, leaf 1 past it
    const action = { id: DISCOVERY_ID, kind: "discovery", orderId: "pool", dueAt: Date.now() } as never;
    await runDiscovery(action, { masterSeed: seed, deployment: d(), session });
    expect(
      noteStore.all().map((n) => n.leafIndex),
      "held for finality: no record awaits it",
    ).toEqual([0]);
    lc.proven = 4;
    await runDiscovery(action, { masterSeed: seed, deployment: d(), session });
    expect(
      noteStore.all().map((n) => n.leafIndex),
      "recorded once proven",
    ).toEqual([0, 1]);
  });

  it("the record's note at two leaves — a deposit's public opening replayed into the tail: neither is recorded before the proof covers it", async () => {
    const seed = session.state().seed!;
    const p3 = prepareShield({ masterSeed: seed, deployment: d(), amount: 3n * 10n ** 17n });
    const rec = newOperation({
      kind: "protect",
      amounts: { asset: "ETH", decimals: 18, input: "1" },
      destination: { kind: "privacy-address", display: "protected-balance", chain: "ethereum" },
      tier: "standard",
    } as never);
    applyEvent(rec.id, { type: "review" });
    applyEvent(rec.id, { type: "confirm" });
    applyEvent(rec.id, { type: "progress", step: "submitting", noteCounter: p3.counter, sender: ACCOUNT } as never);
    applyEvent(rec.id, { type: "submitted", by: "wallet", txHash: ("0x" + "77".repeat(32)) as Hex } as never);
    applyEvent(rec.id, { type: "recovery-required", code: "deposit_unconfirmed", detail: "no receipt" });
    const at = (leaf: number) => noteCommitment(noteBody(p3.note), BigInt(leaf));
    const leaves = new Map(pool.state.inserts.map((x) => [x.leafIndex, x.commitment]));
    leaves.set(4, at(4));
    leaves.set(5, at(5));
    pool.state.inserts = [
      ...pool.state.inserts,
      { leafIndex: 4, commitment: at(4), noteData: p3.noteData, txHash: ("0x" + "77".repeat(32)) as Hex },
      { leafIndex: 5, commitment: at(5), noteData: p3.noteData, txHash: ("0x" + "78".repeat(32)) as Hex },
    ];
    pool.state.next = 8;
    pool.state.root = rootOf(leaves, 8);
    lc.proven = 4; // both past the proof
    const before = noteStore.all().map((n) => n.leafIndex);
    const action = { id: DISCOVERY_ID, kind: "discovery", orderId: "pool", dueAt: Date.now() } as never;
    await runDiscovery(action, { masterSeed: seed, deployment: d(), session });
    expect(
      noteStore.all().map((n) => n.leafIndex),
      "neither of the two: held for finality",
    ).toEqual(before);
    expect(getOperation(rec.id)?.state).toBe("RECOVERY_REQUIRED");
  });

  it("while a deposit its wallet reported nothing for is young the scan runs each minute; at the interval once it is settled", async () => {
    const seed = session.state().seed!;
    const rec = newOperation({
      kind: "protect",
      amounts: { asset: "ETH", decimals: 18, input: "1" },
      destination: { kind: "privacy-address", display: "protected-balance", chain: "ethereum" },
      tier: "standard",
    } as never);
    applyEvent(rec.id, { type: "review" });
    applyEvent(rec.id, { type: "confirm" });
    applyEvent(rec.id, { type: "progress", step: "submitting", noteCounter: 999, sender: ACCOUNT } as never);
    applyEvent(rec.id, { type: "submitted", by: "wallet", txHash: ("0x" + "ef".repeat(32)) as Hex } as never);
    applyEvent(rec.id, { type: "recovery-required", code: "deposit_unconfirmed", detail: "no receipt" });
    const action = { id: DISCOVERY_ID, kind: "discovery", orderId: "pool", dueAt: Date.now() } as never;
    const before = Date.now();
    await runDiscovery(action, { masterSeed: seed, deployment: d(), session });
    const next = session.journal().schedule.find((a) => a.id === DISCOVERY_ID && !a.done);
    expect(next!.dueAt - before, "in a minute").toBeLessThanOrEqual(DISCOVERY_MIN_GAP_MS + 1_000);
    expect(getOperation(rec.id)?.state, "its note not in the pool: it waits").toBe("RECOVERY_REQUIRED");
  });
});
