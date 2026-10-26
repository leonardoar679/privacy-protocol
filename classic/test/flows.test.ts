// The two flows over scripted services (spec v3.0 §7.5–§7.7; V7 Stage 9): a deposit — refused while the pool is not
// live; otherwise the note's commitment to the router from the wallet, the record moved and kept, the receipt read —
// and a withdrawal — the verified history's path, the proof in the (fake) prover, the root still known, the user's
// confirmation, then the relayer's job followed to CONFIRMED or the wallet-mode transaction awaited; cancelled before
// anything is sent when the user declines; failed when the history is not verified; refused when the relayer is offline.
import { describe, expect, it } from "vitest";
import { depositFlow, FlowRefused, withdrawalFlow } from "../src/app/services/flows";
import type { JobRecord } from "../src/app/services/operations";
import { createServices, sourceOf, type ClassicServices } from "../src/app/services/source";
import { WalletSession } from "../src/app/services/wallet";
import { configFromEnv } from "../src/config";
import type { DepositEvent } from "../src/history/events";
import { treeFromFile } from "../src/history/snapshotTree";
import type { TreeFile } from "../src/history/snapshot";
import { circuitInput } from "../src/prover/input";
import { generateNote, formatNote } from "../src/model/notes";
import { memoryHistoryStore, memoryJobsStore } from "../src/storage/historyDb";
import { SELECTORS } from "../src/wallet/calldata";
import { fakeProver, fakeRelayerTransport, fakeWalletProvider, fixtureSnapshot, hex32, POOL_100, scriptedChain, word } from "./helpers/fakes";
import status from "./fixtures/relayers/status.json";

const ROUTER = "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b" as const;
const ACCOUNT = "0x75b9758bba5671c1e71c533a3fa5557f85126c3e" as const;
const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;
const snap = fixtureSnapshot();
const deposits = JSON.parse(snap.texts["deposits.json"]) as DepositEvent[];
const seeded = (seed: number) => {
  let x = seed >>> 0;
  return (n: number) =>
    Uint8Array.from({ length: n }, () => {
      x = (x * 1664525 + 1013904223) >>> 0;
      return x >>> 24;
    });
};
/** a note of the 100 ETH pool whose commitment the fake prover maps to the fixture's sixth deposit */
const NOTE = generateNote("eth", "100", 1, seeded(99));

interface SetupOptions {
  live?: Record<string, string[]>;
  nextIndex?: number;
  knownRoot?: boolean;
  verifiedProof?: boolean;
}
async function setup({ live = { "eth-100": ["deposit", "withdraw"] }, nextIndex = 1024, knownRoot = true, verifiedProof = true }: SetupOptions = {}) {
  const config = configFromEnv({ VITE_CLASSIC_LIVE: JSON.stringify(live), VITE_CLASSIC_RPC_URLS: "https://rpc.example" });
  const chain = scriptedChain({
    head: snap.manifest.toBlock + 200,
    logs: [[]],
    nextIndex,
    knownRoot,
    blockHashes: { [snap.manifest.toBlock]: snap.manifest.blockHash! },
    receipts: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [hex32(BigInt(1000 + i)), { status: "0x1" as const, blockNumber: "0x1" }])),
  });
  const { prover } = fakeProver({ commitmentFor: () => deposits[5].commitment, verified: verifiedProof });
  const provider = fakeWalletProvider(ACCOUNT);
  const wallet = new WalletSession({ router: ROUTER, discover: async () => [{ info: { id: "fake", name: "Fake Wallet" }, provider }] });
  await wallet.discover();
  await wallet.connect("fake");
  const transport = fakeRelayerTransport(status.v4.body);
  const curated = [
    {
      ensName: "to-relayer.eth",
      relayerAddress: status.v4.body.rewardAccount.toLowerCase(),
      url: "https://eth.to-relayer.com",
      rewardAccount: status.v4.body.rewardAccount,
      stakeTorn: "4821",
      feePercent: 0.4,
      version: "4.1.6",
      currentQueue: 0,
    },
  ];
  const jobs = memoryJobsStore();
  const services = createServices({
    config,
    rpc: chain.rpc,
    prover: async () => prover,
    historyStore: memoryHistoryStore(),
    jobs,
    fetchSnapshot: async () => snap,
    relayerTransport: transport,
    curated,
    wallet,
    now: () => 1_700_000_000_000,
    followOptions: { intervalMs: 1, sleep: async () => undefined },
    receiptOptions: { pollMs: 1, sleep: async () => undefined },
  });
  return { services, chain, prover, provider, transport, jobs, config };
}

const states = (seen: JobRecord[]) => seen.map((j) => j.state);

describe("the deposit flow", () => {
  it("refuses while the pool is not live; otherwise the commitment goes to the router from the wallet with the denomination, the record is moved and kept, the receipt completes it", async () => {
    const off = await setup({ live: {} });
    await expect(depositFlow(off.services, { pool: "eth-100", note: NOTE })).rejects.toBeInstanceOf(FlowRefused);
    expect(off.provider.sent).toEqual([]);

    const { services, provider, jobs } = await setup();
    const seen: JobRecord[] = [];
    const job = await depositFlow(services, { pool: "eth-100", note: NOTE, onJob: (j) => seen.push(j) });
    expect(job.state).toBe("COMPLETED");
    expect(job.txHash).toBe(hex32(1000n));
    expect(states(seen)).toEqual(["READY_TO_REVIEW", "AWAITING_AUTHORIZATION", "SUBMITTING", "SOURCE_CONFIRMING", "COMPLETED"]);
    const tx = provider.sent[0] as { from: string; to: string; data: string; value: string };
    expect(tx.to).toBe(ROUTER);
    expect(tx.from).toBe(ACCOUNT);
    expect(BigInt(tx.value)).toBe(100n * 10n ** 18n);
    expect(tx.data.startsWith(SELECTORS.routerDeposit)).toBe(true);
    expect(tx.data.slice(10, 74)).toBe(POOL_100.slice(2).padStart(64, "0"));
    expect(tx.data.slice(74, 138)).toBe(deposits[5].commitment.slice(2));
    expect((await jobs.list()).map((j) => j.state)).toEqual(["COMPLETED"]);
    // the record carries no note and no recipient
    expect(JSON.stringify(await jobs.list())).not.toContain(formatNote(NOTE).slice(-40));
  });

  it("straight to the pool when asked (the router disabled the instance); a wallet refusal fails the record", async () => {
    const { services, provider } = await setup();
    const job = await depositFlow(services, { pool: "eth-100", note: NOTE, direct: true });
    expect(job.state).toBe("COMPLETED");
    expect((provider.sent[0] as { to: string; data: string }).to).toBe(POOL_100);
    expect((provider.sent[0] as { data: string }).data.startsWith(SELECTORS.poolDeposit)).toBe(true);
    provider.request = async ({ method }: { method: string }) => {
      if (method === "eth_sendTransaction") throw new Error("User rejected the request");
      return method === "eth_chainId" ? "0x1" : [ACCOUNT];
    };
    const refused = await depositFlow(services, { pool: "eth-100", note: NOTE });
    expect(refused.state).toBe("FAILED");
    expect(refused.failedReason).toMatch(/rejected/);
  });
});

describe("the withdrawal flow", () => {
  async function ready(over: Parameters<typeof setup>[0] = {}) {
    const s = await setup(over);
    await s.services.relayers.refresh();
    await s.services.histories.get("eth-100")!.ensure();
    const lookup = await sourceOf(s.services).lookup(NOTE);
    expect(lookup.kind).toBe("found");
    const facts = lookup.kind === "found" ? lookup.facts : null!;
    return { ...s, facts };
  }

  it("relayer mode: the path, the proof with the relayer's account and fee, the confirmation, the request as the relayer wants it, the job followed to CONFIRMED", async () => {
    const { services, prover, transport, facts } = await ready();
    const seen: JobRecord[] = [];
    const steps: string[] = [];
    const job = await withdrawalFlow(services, {
      pool: "eth-100",
      note: NOTE,
      facts,
      recipient: RECIPIENT,
      via: "relayer",
      relayerId: "to-relayer.eth",
      feeWei: 10n ** 17n,
      confirm: async () => true,
      onStep: (s) => steps.push(s.step === "following" ? `following:${s.relayerState}` : s.step),
      onJob: (j) => seen.push(j),
    });
    expect(job.state).toBe("COMPLETED");
    expect(job.relayerState).toBe("CONFIRMED");
    expect(job.txHash).toBe(hex32(777n));
    expect(job.relayerJobId).toBe("job-1");
    expect(states(seen).slice(0, 5)).toEqual(["READY_TO_REVIEW", "PREPARING_PROOF", "AWAITING_AUTHORIZATION", "SUBMITTING", "SUBMITTING"]);
    // the proof step repeats with the worker's progress (witness, proof): collapsed here
    expect(steps.filter((s, i) => s !== steps[i - 1])).toEqual([
      "proof",
      "confirm",
      "submitting",
      "following:QUEUED",
      "following:SENT",
      "following:MINED",
      "following:CONFIRMED",
      "done",
    ]);
    const input = prover.proofs[0];
    expect(input.recipient).toBe(BigInt(RECIPIENT).toString());
    expect(input.relayer).toBe(BigInt(status.v4.body.rewardAccount).toString());
    expect(input.fee).toBe((10n ** 17n).toString());
    expect(input.pathElements.length).toBe(20);
    expect(BigInt(input.root)).toBe(BigInt(snap.manifest.root));
    // the flow builds the input from the worker's derivation and the note's bytes: exactly what prover/input.ts (the vectors' builder) derives on its own
    const path = treeFromFile(JSON.parse(snap.texts["tree.json"]) as TreeFile).path(facts.leafIndex);
    expect(input).toEqual(
      circuitInput(NOTE, path, {
        root: BigInt(snap.manifest.root),
        recipient: RECIPIENT,
        relayer: status.v4.body.rewardAccount as `0x${string}`,
        feeWei: 10n ** 17n,
        refundWei: 0n,
      }),
    );
    const posted = transport.posted[0] as { url: string; body: { proof: string; contract: string; args: string[] } };
    expect(posted.url).toBe("https://eth.to-relayer.com/v1/tornadoWithdraw");
    expect(posted.body.contract).toBe(POOL_100);
    expect(posted.body.args[0]).toBe(snap.manifest.root);
    expect(posted.body.args[2]).toBe(RECIPIENT);
    expect(posted.body.args[3]).toBe(status.v4.body.rewardAccount.toLowerCase());
    expect(posted.body.args[4]).toBe(`0x${word(10n ** 17n)}`);
    expect(posted.body.proof).toMatch(/^0x[0-9a-f]{512}$/);
  });

  it("wallet mode: the proof with no relayer and no fee, the pool's own withdraw from the account, the receipt", async () => {
    const { services, provider, prover, facts } = await ready();
    const job = await withdrawalFlow(services, { pool: "eth-100", note: NOTE, facts, recipient: RECIPIENT, via: "wallet", confirm: async () => true });
    expect(job.state).toBe("COMPLETED");
    expect(job.via).toBe("wallet");
    expect(prover.proofs[0].relayer).toBe("0");
    expect(prover.proofs[0].fee).toBe("0");
    const tx = provider.sent[0] as { to: string; data: string; value: string };
    expect(tx.to).toBe(POOL_100);
    expect(tx.data.startsWith(SELECTORS.poolWithdraw)).toBe(true);
    expect(BigInt(tx.value)).toBe(0n);
  });

  it("declined at the confirmation: cancelled, nothing sent; an unverified history fails before any proof; an offline relayer is refused", async () => {
    const { services, provider, transport, facts, prover } = await ready();
    const cancelled = await withdrawalFlow(services, { pool: "eth-100", note: NOTE, facts, recipient: RECIPIENT, via: "wallet", confirm: async () => false });
    expect(cancelled.state).toBe("CANCELLED");
    expect(provider.sent).toEqual([]);
    expect(transport.posted).toEqual([]);
    expect(prover.proofs.length).toBe(1);

    const unverified = await setup({ nextIndex: 999, knownRoot: false });
    await unverified.services.histories.get("eth-100")!.ensure();
    const job = await withdrawalFlow(unverified.services, {
      pool: "eth-100",
      note: NOTE,
      facts,
      recipient: RECIPIENT,
      via: "wallet",
      confirm: async () => true,
    });
    expect(job.state).toBe("FAILED");
    expect(job.failedReason).toMatch(/not verified/);
    expect(unverified.prover.proofs.length).toBe(0);

    await expect(
      withdrawalFlow(services, {
        pool: "eth-100",
        note: NOTE,
        facts,
        recipient: RECIPIENT,
        via: "relayer",
        relayerId: "nobody.eth",
        confirm: async () => true,
      }),
    ).rejects.toBeInstanceOf(FlowRefused);
    const off = await setup({ live: {} });
    await expect(
      withdrawalFlow(off.services, { pool: "eth-100", note: NOTE, facts, recipient: RECIPIENT, via: "wallet", confirm: async () => true }),
    ).rejects.toBeInstanceOf(FlowRefused);
  });

  it("a proof the worker could not verify fails the record before anything leaves", async () => {
    const { services, provider, facts } = await ready({ verifiedProof: false });
    const job = await withdrawalFlow(services, { pool: "eth-100", note: NOTE, facts, recipient: RECIPIENT, via: "wallet", confirm: async () => true });
    expect(job.state).toBe("FAILED");
    expect(job.failedReason).toMatch(/did not verify/);
    expect(provider.sent).toEqual([]);
  });
});

describe("the source over the services", () => {
  it("statistics, a lookup through the worker's derivation, the relayers asked once, the gas price live, the availability rows, the device's records", async () => {
    const { services, jobs } = await setup();
    const source = sourceOf(services);
    expect((await source.stats("eth-100")).deposits).toBe(1024);
    const found = await source.lookup(NOTE);
    expect(found).toMatchObject({ kind: "found", pool: "eth-100", facts: { leafIndex: 5, depositsSince: 1018 } });
    expect(await source.lookup({ ...NOTE, netId: 5 })).toEqual({ kind: "other-network", netId: 5 });
    expect(await source.lookup({ ...NOTE, amount: "7" })).toEqual({ kind: "unknown-pool" });
    expect((await source.relayers()).map((r) => r.status)).toEqual(["online"]);
    expect(await source.gasPriceWei()).toBe(12_000_000_000n);
    const a = await source.availability("eth-100");
    expect(a.history.text).toBe("availability.historySynced");
    expect(a.wallet.text).toBe("availability.walletConnected");
    expect(a.relayers).toEqual({ state: "ok", text: "availability.relayersOnline", params: { n: 1 } });
    await jobs.put({ id: "x", kind: "deposit", pool: "eth-100", state: "COMPLETED", createdAt: 1, updatedAt: 2, txHash: hex32(5n) });
    expect((await source.history()).map((r) => r.status)).toEqual(["deposited"]);
    const s2 = services as ClassicServices;
    expect(s2.config.live["eth-100"]).toEqual(["deposit", "withdraw"]);
  });
});
