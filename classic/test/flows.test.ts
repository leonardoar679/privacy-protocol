// The two flows over scripted services (spec v3.0 §7.5–§7.7; V7 Stage 9): a deposit — refused while the pool is not
// live; otherwise the note's commitment to the router from the wallet, the record moved and kept, the receipt read —
// and a withdrawal — the verified history's path, the proof in the (fake) prover, the root still known, the user's
// confirmation, then the relayer's job followed to CONFIRMED or the wallet-mode transaction awaited; cancelled before
// anything is sent when the user declines; failed when the history is not verified; refused when the relayer is offline.
import { readFileSync } from "node:fs";
import { keccak256 } from "js-sha3";
import { describe, expect, it } from "vitest";
import { depositFlow, FlowRefused, withdrawalFlow } from "../src/app/services/flows";
import { sourceOf as sourceOfServices } from "../src/app/services/source";
import { DEPLOYMENT } from "../src/model/pools";
import { feeLines } from "../src/model/fees";
import { poolOf } from "../src/model/pools";
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
import { depositLog, fakeProver, fakeRelayerTransport, fakeWalletProvider, fixtureSnapshot, hex32, POOL_100, scriptedChain, word } from "./helpers/fakes";
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
  /** the pool's code the chain serves (the real one unless a test says otherwise) */
  code?: string;
  /** the relayer's job states, in order of the polls */
  jobStates?: string[];
  knownRoot?: boolean;
  verifiedProof?: boolean;
}
/** The fee the screen offers at the scripted 12 gwei: the original's 550,000 gas plus the relayer's 0.4 % — above the relayer's own 390,000-gas minimum. */
const FEE = feeLines(poolOf("eth-100"), { feePercentE4: 4000 }, 12_000_000_000n).totalFeeWei;
// the pool's real code and its pins (the review round of 2026-11-03, C2-6): the flows refuse an unverified contract, so the scripted
// chain serves the Sourcify record's bytecode (the 1, 10 and 100 ETH pools share it) and answers the pinned facts
const POOL_CODE = (
  JSON.parse(readFileSync(new URL("../contracts/verified/pool-eth-1.json", import.meta.url), "utf8")) as { runtimeBytecode: { onchainBytecode: string } }
).runtimeBytecode.onchainBytecode;
const sel = (signature: string) => "0x" + keccak256(signature).slice(0, 8);
const PIN = DEPLOYMENT.pools["eth-100"];
const PIN_CALLS: Record<string, string> = {
  [sel("verifier()")]: `0x${PIN.verifier.slice(2).padStart(64, "0")}`,
  [sel("levels()")]: `0x${word(PIN.levels)}`,
  [sel("denomination()")]: `0x${word(BigInt(PIN.denominationWei))}`,
  [sel("instances(address)")]: `0x${word(0)}${word(0)}${word(1)}${word(0)}${word(30)}`, // the router lists the pool as enabled
};

async function setup({
  live = { "eth-100": ["deposit", "withdraw"] },
  nextIndex = 1024,
  knownRoot = true,
  verifiedProof = true,
  code = POOL_CODE,
  jobStates,
}: SetupOptions = {}) {
  const config = configFromEnv({ VITE_CLASSIC_LIVE: JSON.stringify(live), VITE_CLASSIC_RPC_URLS: "https://rpc.example" });
  const chain = scriptedChain({
    head: snap.manifest.toBlock + 200,
    logs: [[]],
    nextIndex,
    knownRoot,
    code,
    calls: PIN_CALLS,
    blockHashes: { [snap.manifest.toBlock]: snap.manifest.blockHash! },
    receipts: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [hex32(BigInt(1000 + i)), { status: "0x1" as const, blockNumber: "0x1" }])),
  });
  const { prover } = fakeProver({ commitmentFor: () => deposits[5].commitment, verified: verifiedProof });
  const provider = fakeWalletProvider(ACCOUNT);
  const wallet = new WalletSession({ router: ROUTER, discover: async () => [{ info: { id: "fake", name: "Fake Wallet" }, provider }] });
  await wallet.discover();
  await wallet.connect("fake");
  const transport = fakeRelayerTransport(status.v4.body, jobStates);
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
    receiptOptions: { pollMs: 1, maxMs: 20, sleep: async () => undefined }, // a receipt that never comes ends the wait after 20 ms of wall clock
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
    // the note's pool is the pool deposited into (the review round of 2026-11-03, C2-2): a 100 ETH note never goes to the 1 ETH pool
    const both = await setup({ live: { "eth-100": ["deposit"], "eth-1": ["deposit"] } });
    await expect(depositFlow(both.services, { pool: "eth-1", note: NOTE })).rejects.toThrow(/not the one selected/);
    expect(both.provider.sent).toEqual([]);
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
    // the device's store holds no deposit record — a deposit row beside this device's withdrawal rows is the link the pool hides (the
    // fourth review round, 2026-11-03): the page's memory store holds it, and only until the page is gone
    expect(await jobs.list()).toEqual([]);
    expect((await services.depositJobs.list()).map((j) => j.state)).toEqual(["COMPLETED"]);
    // the record carries no note and no recipient
    expect(JSON.stringify(await services.depositJobs.list())).not.toContain(formatNote(NOTE).slice(-40));
  });

  it("a deposit whose receipt did not arrive in time is read again when the history is read, and the chain's receipt completes it (the fourth review round, 2026-11-03)", async () => {
    const { services, chain } = await setup();
    const receipts = chain.options.receipts!;
    const mined = { ...receipts };
    for (const k of Object.keys(receipts)) delete receipts[k]; // nothing mined yet: an underpriced deposit
    const job = await depositFlow(services, { pool: "eth-100", note: NOTE });
    expect(job.state).toBe("FAILED");
    expect(job.failedReason).toMatch(/not mined in time/);
    expect(job.txHash).toBe(hex32(1000n));
    Object.assign(receipts, mined); // mined later
    const rows = await sourceOf(services).history();
    expect(rows.map((r) => [r.kind, r.status])).toEqual([["deposit", "deposited"]]);
    expect((await services.depositJobs.list()).map((j) => j.state)).toEqual(["COMPLETED"]);
    expect(await services.jobs.list(), "the device's store holds no deposit").toEqual([]);
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
      feeWei: FEE,
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
    expect(input.fee).toBe(FEE.toString());
    expect(input.pathElements.length).toBe(20);
    expect(BigInt(input.root)).toBe(BigInt(snap.manifest.root));
    // the flow builds the input from the worker's derivation and the note's bytes: exactly what prover/input.ts (the vectors' builder) derives on its own
    const path = treeFromFile(JSON.parse(snap.texts["tree.json"]) as TreeFile).path(facts.leafIndex);
    expect(input).toEqual(
      circuitInput(NOTE, path, {
        root: BigInt(snap.manifest.root),
        recipient: RECIPIENT,
        relayer: status.v4.body.rewardAccount as `0x${string}`,
        feeWei: FEE,
        refundWei: 0n,
      }),
    );
    const posted = transport.posted[0] as { url: string; body: { proof: string; contract: string; args: string[] } };
    expect(posted.url).toBe("https://eth.to-relayer.com/v1/tornadoWithdraw");
    expect(posted.body.contract).toBe(POOL_100);
    expect(posted.body.args[0]).toBe(snap.manifest.root);
    expect(posted.body.args[2]).toBe(RECIPIENT);
    expect(posted.body.args[3]).toBe(status.v4.body.rewardAccount.toLowerCase());
    expect(posted.body.args[4]).toBe(`0x${word(FEE)}`);
    expect(posted.body.proof).toMatch(/^0x[0-9a-f]{512}$/);
  });

  it("a fee below the relayer's minimum at the live gas price is refused before any proof, with both numbers (the review round of 2026-11-02)", async () => {
    const { services, prover, facts } = await ready();
    const low = withdrawalFlow(services, {
      pool: "eth-100",
      note: NOTE,
      facts,
      recipient: RECIPIENT,
      via: "relayer",
      relayerId: "to-relayer.eth",
      feeWei: 10n ** 16n,
      confirm: async () => true,
    });
    await expect(low).rejects.toBeInstanceOf(FlowRefused);
    await expect(low).rejects.toThrow(/the fee offered \(10000000000000000 wei\) is below the relayer's minimum at the current gas price \(\d+ wei\)/);
    expect(prover.proofs).toHaveLength(0);
  });
  it("a contract that is not the pinned one, or no endpoint: nothing is sent, deposit or withdrawal (the review round of 2026-11-03, C2-6)", async () => {
    const differs = await setup({ code: "0x6001" });
    await expect(depositFlow(differs.services, { pool: "eth-100", note: NOTE })).rejects.toThrow(/not ready for a deposit/);
    expect(differs.provider.sent).toEqual([]);
    const lookup = await sourceOf(differs.services).lookup(NOTE);
    const facts = lookup.kind === "found" ? lookup.facts : null!;
    const job = await withdrawalFlow(differs.services, {
      pool: "eth-100",
      note: NOTE,
      facts,
      recipient: RECIPIENT,
      via: "relayer",
      relayerId: "to-relayer.eth",
      feeWei: FEE,
      confirm: async () => true,
    }).catch((e: unknown) => e);
    expect(job).toBeInstanceOf(FlowRefused);
    expect(differs.prover.proofs).toHaveLength(0);
    expect(differs.transport.posted).toEqual([]);
  });
  it("a note spent on chain since the history's last block is refused before any proof, and again before anything is sent (the review round of 2026-11-03, C2-10)", async () => {
    const { services, prover, transport, facts, chain } = await ready();
    chain.options.spent = true;
    const job = await withdrawalFlow(services, {
      pool: "eth-100",
      note: NOTE,
      facts,
      recipient: RECIPIENT,
      via: "relayer",
      relayerId: "to-relayer.eth",
      feeWei: FEE,
      confirm: async () => true,
    });
    expect(job.state).toBe("FAILED");
    expect(job.failedReason).toMatch(/spent on chain/);
    expect(prover.proofs, "nothing proved").toHaveLength(0);
    expect(transport.posted).toEqual([]);
    // spent between the proof and the confirmation: refused before the submission
    const again = await ready();
    const late = await withdrawalFlow(again.services, {
      pool: "eth-100",
      note: NOTE,
      facts: again.facts,
      recipient: RECIPIENT,
      via: "relayer",
      relayerId: "to-relayer.eth",
      feeWei: FEE,
      confirm: async () => {
        again.chain.options.spent = true;
        return true;
      },
    });
    expect(late.state).toBe("FAILED");
    expect(late.failedReason).toMatch(/spent on chain/);
    expect(again.transport.posted, "nothing sent").toEqual([]);
  });
  it("a relayer whose answer did not arrive leaves the record waiting as RECOVERY_REQUIRED, never FAILED (the review round of 2026-11-03, C2-3): the job may have been taken", async () => {
    const { services, prover, transport, facts } = await ready();
    transport.postJson = async () => {
      throw new Error("The operation was aborted");
    };
    const job = await withdrawalFlow(services, {
      pool: "eth-100",
      note: NOTE,
      facts,
      recipient: RECIPIENT,
      via: "relayer",
      relayerId: "to-relayer.eth",
      feeWei: FEE,
      confirm: async () => true,
    });
    expect(job.state).toBe("RECOVERY_REQUIRED");
    expect(job.failedReason).toMatch(/answer did not arrive.*check on chain/);
    expect(job.relayerUrl, "kept for the follow-up").toBe("https://eth.to-relayer.com");
    expect(prover.proofs).toHaveLength(1);
  });
  it("a relayed job whose page is gone is asked about again when the history is read, never re-submitted (the review round of 2026-11-03, C2-8)", async () => {
    const { services, transport } = await setup({ jobStates: ["CONFIRMED"] });
    const now = services.now();
    await services.jobs.put({
      id: "j1",
      kind: "withdrawal",
      pool: "eth-100",
      state: "SUBMITTING",
      createdAt: now,
      updatedAt: now,
      via: "relayer",
      relayerUrl: "https://eth.to-relayer.com",
      relayerJobId: "job-1",
    });
    const rows = await sourceOfServices(services).history();
    expect(rows[0]).toMatchObject({ id: "j1", status: "CONFIRMED", txHash: hex32(777n) });
    expect((await services.jobs.list())[0]).toMatchObject({ state: "COMPLETED", relayerState: "CONFIRMED" });
    expect(transport.posted, "read, never sent").toEqual([]);
  });
  it("the root is checked again after the confirmation: aged out of the pool's hundred meanwhile → the history synced again, proved again once, then submitted (Stage 10)", async () => {
    const { services, chain, prover, transport, facts } = await ready();
    const oldRoot = snap.manifest.root.toLowerCase();
    const job = await withdrawalFlow(services, {
      pool: "eth-100",
      note: NOTE,
      facts,
      recipient: RECIPIENT,
      via: "relayer",
      relayerId: "to-relayer.eth",
      feeWei: FEE,
      confirm: async () => {
        // while the user looked at the confirmation, another deposit landed and the pool's window moved past the proof's root
        chain.options.head = snap.manifest.toBlock + 300; // the chain moved on: the new deposit sits in the next window
        chain.options.logs = [[depositLog(POOL_100, 1024, 777_777n, snap.manifest.toBlock + 250)]];
        chain.options.nextIndex = 1025;
        chain.options.knownRoots = (root) => root.toLowerCase() !== oldRoot;
        chain.options.lastRoot = hex32(5n);
        return true;
      },
    });
    expect(job.state, job.failedReason ?? "").toBe("COMPLETED");
    expect(prover.proofs.length).toBe(2);
    expect(BigInt(prover.proofs[0].root)).toBe(BigInt(oldRoot));
    expect(BigInt(prover.proofs[1].root)).not.toBe(BigInt(oldRoot));
    expect(prover.proofs[1].pathElements).not.toEqual(prover.proofs[0].pathElements);
    const posted = transport.posted[0] as { body: { args: string[] } };
    expect(BigInt(posted.body.args[0])).toBe(BigInt(prover.proofs[1].root));
    expect(services.histories.get("eth-100")!.state!.leaves).toBe(1025);
  });

  it("a recipient a withdrawal must not go to — the zero address, a burn address, a contract of the pools — is refused before any proof (the fourth review round, 2026-11-03)", async () => {
    const { services, prover, transport, facts } = await ready();
    for (const recipient of ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dEaD", POOL_100, ROUTER] as const) {
      const refused = withdrawalFlow(services, {
        pool: "eth-100",
        note: NOTE,
        facts,
        recipient,
        via: "relayer",
        relayerId: "to-relayer.eth",
        feeWei: FEE,
        confirm: async () => true,
      });
      await expect(refused).rejects.toBeInstanceOf(FlowRefused);
      await expect(refused).rejects.toThrow(/the zero address, a burn address or a contract of the pools: a withdrawal sent there is lost/);
    }
    expect(prover.proofs).toHaveLength(0);
    expect(transport.posted).toHaveLength(0);
  });

  it("a root the pool does not know even after the history was synced and the proof made again: FAILED with the reason, nothing sent (the fourth review round, 2026-11-03)", async () => {
    const { services, chain, prover, transport, facts } = await ready();
    const job = await withdrawalFlow(services, {
      pool: "eth-100",
      note: NOTE,
      facts,
      recipient: RECIPIENT,
      via: "relayer",
      relayerId: "to-relayer.eth",
      feeWei: FEE,
      confirm: async () => {
        // the pool's answers while the user looked at the confirmation: the proof's root unknown (1), the synced history's root
        // known (2), the re-proof's root unknown again (3) — a window that moved twice. Before, the re-proof went out unchecked
        let asked = 0;
        chain.options.knownRoots = () => [false, true, false][asked++] ?? false;
        chain.options.lastRoot = hex32(5n);
        return true;
      },
    });
    expect(job.state).toBe("FAILED");
    expect(job.failedReason).toMatch(/not among the pool's last hundred even after the history was synced and the proof made again: nothing is sent/);
    expect(prover.proofs.length).toBe(2);
    expect(transport.posted).toHaveLength(0);
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
