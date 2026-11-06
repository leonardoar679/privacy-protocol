// The two flows over scripted services (spec v3.0 §7.5–§7.7; V7 Stage 9): a deposit — refused while the pool is not
// live; otherwise the note's commitment to the router from the wallet, the record moved and kept, the receipt read —
// and a withdrawal — the verified history's path, the proof in the (fake) prover, the root still known, the user's
// confirmation, then the relayer's job followed to CONFIRMED or the wallet-mode transaction awaited; cancelled before
// anything is sent when the user declines; failed when the history is not verified; refused when the relayer is offline.
import { readFileSync } from "node:fs";
import { keccak256 } from "js-sha3";
import { describe, expect, it } from "vitest";
import type { Rpc } from "../src/history/sync";
import { depositFlow, FlowRefused, withdrawalFlow } from "../src/app/services/flows";
import { sourceOf as sourceOfServices } from "../src/app/services/source";
import { DEPLOYMENT } from "../src/model/pools";
import { feeLines } from "../src/model/fees";
import { poolOf } from "../src/model/pools";
import { noteDigestOf, type JobRecord } from "../src/app/services/operations";
import { createServices, sourceOf, SUBMISSION_LOST_MS, type ClassicServices } from "../src/app/services/source";
import { WalletSession } from "../src/app/services/wallet";
import { configFromEnv } from "../src/config";
import type { DepositEvent } from "../src/history/events";
import { treeFromFile } from "../src/history/snapshotTree";
import type { TreeFile } from "../src/history/snapshot";
import { circuitInput } from "../src/prover/input";
import { generateNote, formatNote } from "../src/model/notes";
import { memoryHistoryStore, memoryJobsStore } from "../src/storage/historyDb";
import { SELECTORS } from "../src/wallet/calldata";
import { SELECTORS as VIEW } from "../src/history/verify";
import { plainText } from "../src/app/services/source";
import {
  depositLog,
  fakeProver,
  fakeRelayerTransport,
  fakeWalletProvider,
  fixtureSnapshot,
  hex32,
  POOL_100,
  scriptedChain,
  withdrawalLog,
  word,
} from "./helpers/fakes";
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
  /** a second endpoint's word before a wallet-mode send (the fifth review round, 2026-11-03) */
  secondOpinion?: Rpc | null;
  /** the fake prover derives each note's own commitment (a note with no deposit misses), not the fixture's sixth deposit's */
  realCommitments?: boolean;
  /** the sanctions oracle switched on, answering clear or listed — or not answering (the tenth review round, C10-9) */
  oracle?: "clear" | "listed" | "unreachable";
  /** every eth_getLogs fails (an endpoint that refuses logs) */
  logsFail?: boolean;
  /** a wallet that answers no receipts (the app's endpoint then does; C10-12) */
  walletReceipts?: "none";
  /** the prover the services hand out (the fake one otherwise) */
  prover?: ReturnType<typeof fakeProver>["prover"];
  /** wraps the app's endpoint (a wallet that switches accounts while the oracle is read: the eleventh review round's critique of C11-7) */
  rpcWrap?: (rpc: Rpc) => Rpc;
  /** the first endpoint alone, beside a second opinion (the critique of C11-12) */
  firstOpinion?: Rpc | null;
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
  secondOpinion,
  realCommitments = false,
  oracle,
  logsFail = false,
  walletReceipts,
  prover: proverOverride,
  rpcWrap,
  firstOpinion,
}: SetupOptions = {}) {
  const config = configFromEnv({
    VITE_CLASSIC_LIVE: JSON.stringify(live),
    VITE_CLASSIC_RPC_URLS: "https://rpc.example",
    ...(oracle ? { VITE_CLASSIC_COMPLIANCE_ORACLE: "1" } : {}),
  });
  const transport = fakeRelayerTransport(status.v4.body, jobStates);
  const chain = scriptedChain({
    head: snap.manifest.toBlock + 200,
    logs: [[]],
    nextIndex,
    knownRoot,
    code,
    calls: {
      ...PIN_CALLS,
      ...(oracle === "clear" || oracle === "listed" ? { [sel("isSanctioned(address)")]: `0x${word(oracle === "listed" ? 1 : 0)}` } : {}),
    },
    // the pool shows the note spent once the relayer has the job — it sent it: a relayer's CONFIRMED is believed then (the tenth review round, C10-3)
    spent: () => transport.posted.length > 0,
    blockHashes: { [snap.manifest.toBlock]: snap.manifest.blockHash! },
    receipts: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [hex32(BigInt(1000 + i)), { status: "0x1" as const, blockNumber: "0x1" }])),
  });
  const rpc: Rpc = logsFail
    ? async (method, params) => {
        if (method === "eth_getLogs") throw new Error("upstream connect error or disconnect/reset before headers");
        return chain.rpc(method, params);
      }
    : chain.rpc;
  const { prover } = proverOverride
    ? { prover: proverOverride }
    : fakeProver({ ...(realCommitments ? {} : { commitmentFor: () => deposits[5].commitment }), verified: verifiedProof });
  const provider = fakeWalletProvider(ACCOUNT, 1, walletReceipts ? { receipts: walletReceipts } : {});
  const wallet = new WalletSession({ router: ROUTER, discover: async () => [{ info: { id: "fake", name: "Fake Wallet" }, provider }] });
  await wallet.discover();
  await wallet.connect("fake");
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
    rpc: rpcWrap ? rpcWrap(rpc) : rpc,
    prover: async () => prover,
    historyStore: memoryHistoryStore(),
    jobs,
    fetchSnapshot: async () => snap,
    relayerTransport: transport,
    curated,
    wallet,
    ...(secondOpinion !== undefined ? { secondOpinion } : {}),
    ...(firstOpinion !== undefined ? { firstOpinion } : {}),
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

  it("a deposit whose receipt did not arrive in time stays sent and waiting — never 'did not go through' — and is read again when the history is read (the fourth review round, 2026-11-03; the tenth, C10-4)", async () => {
    const { services, provider } = await setup();
    provider.receipts[hex32(1000n)] = null; // nothing mined yet: an underpriced deposit
    const job = await depositFlow(services, { pool: "eth-100", note: NOTE });
    expect(job.state).toBe("SOURCE_CONFIRMING");
    expect(job.failedReason).toBeUndefined();
    expect(job.txHash).toBe(hex32(1000n));
    delete provider.receipts[hex32(1000n)]; // mined later
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
  it("a note spent on chain since the history's last block is refused once confirmed, before anything is sent (the review round of 2026-11-03, C2-10) — read only then, never before the confirmation (the tenth review round, C10-13)", async () => {
    const { services, prover, transport, facts, chain } = await ready();
    chain.options.spent = true;
    const spentReads = () => chain.seen.filter((c) => c.method === "eth_call" && (c.params[0] as { data: string }).data.startsWith(VIEW.isSpent)).length;
    let readsAtConfirmation = -1;
    const job = await withdrawalFlow(services, {
      pool: "eth-100",
      note: NOTE,
      facts,
      recipient: RECIPIENT,
      via: "relayer",
      relayerId: "to-relayer.eth",
      feeWei: FEE,
      confirm: async () => {
        readsAtConfirmation = spentReads();
        return true;
      },
    });
    expect(job.state).toBe("FAILED");
    expect(job.failedReason).toMatch(/spent on chain/);
    expect(readsAtConfirmation, "the endpoint learned nothing of the note before the user confirmed").toBe(0);
    expect(prover.proofs).toHaveLength(1);
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
  it("a relayed job whose page is gone is asked about again when the history is read, never re-submitted (the review round of 2026-11-03, C2-8) — its CONFIRMED the relayer's report until the pool's Withdrawal events hold its transaction (the tenth review round, C10-3)", async () => {
    const { services, transport, chain } = await setup({ jobStates: ["CONFIRMED"] });
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
      // the record's keyed digest of the note's nullifier hash (the eleventh review round, C11-1)
      noteDigest: noteDigestOf("j1", hex32(4242n)),
    });
    const rows = await sourceOfServices(services).history();
    expect(rows[0]).toMatchObject({ id: "j1", status: "reported", txHash: hex32(777n) });
    expect((await services.jobs.list())[0]).toMatchObject({ state: "SOURCE_CONFIRMING", relayerState: "CONFIRMED" });
    // the pool's next delta holds the withdrawal's transaction: complete then
    chain.options.head = snap.manifest.toBlock + 400;
    chain.options.logs = [[withdrawalLog(POOL_100, hex32(4242n), snap.manifest.toBlock + 300, { txHash: hex32(777n) })]];
    await services.histories.get("eth-100")!.refresh();
    const again = await sourceOfServices(services).history();
    expect(again[0]).toMatchObject({ id: "j1", status: "CONFIRMED" });
    expect((await services.jobs.list())[0]).toMatchObject({ state: "COMPLETED", relayerState: "CONFIRMED" });
    expect((await services.jobs.list())[0].noteDigest, "an ended record keeps no digest of its note").toBeUndefined();
    expect(transport.posted, "read, never sent").toEqual([]);
  });

  it("a relayer's CONFIRMED naming another note's withdrawal of the pool completes nothing; a record from before the digest waits for a look on chain (the eleventh review round, C11-1)", async () => {
    const { services, chain } = await setup({ jobStates: ["CONFIRMED"] });
    const now = services.now();
    const relayed = {
      kind: "withdrawal" as const,
      pool: "eth-100" as const,
      state: "SUBMITTING" as const,
      createdAt: now,
      updatedAt: now,
      via: "relayer" as const,
      relayerUrl: "https://eth.to-relayer.com",
    };
    await services.jobs.put({ ...relayed, id: "j1", relayerJobId: "job-1", noteDigest: noteDigestOf("j1", hex32(4242n)) });
    await services.jobs.put({ ...relayed, id: "j2", relayerJobId: "job-2" });
    await sourceOfServices(services).history();
    // the transaction the relayer names is a withdrawal of the pool — of another note (4243), not this record's (4242)
    chain.options.head = snap.manifest.toBlock + 400;
    chain.options.logs = [[withdrawalLog(POOL_100, hex32(4243n), snap.manifest.toBlock + 300, { txHash: hex32(777n) })]];
    await services.histories.get("eth-100")!.refresh();
    const rows = await sourceOfServices(services).history();
    expect(rows.find((r) => r.id === "j1")).toMatchObject({ status: "reported" });
    expect(
      rows.find((r) => r.id === "j2"),
      "no digest: never completed on a transaction alone",
    ).toMatchObject({ status: "reported" });
    expect((await services.jobs.list()).map((j) => j.state)).toEqual(["SOURCE_CONFIRMING", "SOURCE_CONFIRMING"]);
    expect(noteDigestOf("j1", hex32(4242n)), "keyed by the record: another record's digest of the same note differs").not.toBe(
      noteDigestOf("j2", hex32(4242n)),
    );
  });

  it("a relayed submission whose answer was lost says its outcome is unknown, and is settled once the pool's Withdrawal events name its note (the eleventh review round, VC-N1)", async () => {
    const { services, chain, transport } = await setup();
    const now = services.now();
    await services.jobs.put({
      id: "j3",
      kind: "withdrawal",
      pool: "eth-100",
      state: "RECOVERY_REQUIRED",
      createdAt: now,
      updatedAt: now,
      via: "relayer",
      relayerUrl: "https://eth.to-relayer.com",
      failedReason: "the relayer's answer did not arrive: check on chain",
      noteDigest: noteDigestOf("j3", hex32(4242n)),
    });
    expect((await sourceOfServices(services).history())[0]).toMatchObject({ id: "j3", status: "unknown" });
    chain.options.head = snap.manifest.toBlock + 400;
    chain.options.logs = [[withdrawalLog(POOL_100, hex32(4242n), snap.manifest.toBlock + 300, { txHash: hex32(778n) })]];
    await services.histories.get("eth-100")!.refresh();
    expect((await sourceOfServices(services).history())[0]).toMatchObject({ id: "j3", status: "withdrawn", txHash: hex32(778n) });
    const [record] = await services.jobs.list();
    expect(record).toMatchObject({ state: "COMPLETED", txHash: hex32(778n) });
    expect(record.noteDigest).toBeUndefined();
    expect(transport.posted, "read, never sent").toEqual([]);
  });

  it("the second endpoint is asked at the history's own sync, never at the withdrawal's moment (the tenth review round, C10-14; the eleventh, C11-9, C11-12): one that disagrees leaves the history unverified and nothing is proved or sent; one that agrees is asked nothing of a relayed withdrawal", async () => {
    const other = (knownRoot: boolean) =>
      scriptedChain({
        head: snap.manifest.toBlock + 200,
        logs: [[]],
        nextIndex: 1024,
        knownRoot,
        calls: PIN_CALLS,
        blockHashes: { [snap.manifest.toBlock]: snap.manifest.blockHash! },
      });
    const relayed = (facts: Parameters<typeof withdrawalFlow>[1]["facts"]) => ({
      pool: "eth-100" as const,
      note: NOTE,
      facts,
      recipient: RECIPIENT,
      via: "relayer" as const,
      relayerId: "to-relayer.eth",
      feeWei: FEE,
      confirm: async () => true,
    });
    const lying = other(false);
    const a = await ready({ secondOpinion: lying.rpc });
    expect(a.services.histories.get("eth-100")!.status).toMatchObject({
      kind: "ready",
      verified: false,
      reason: expect.stringMatching(/second RPC endpoint does not agree with this history/),
    });
    const refused = await withdrawalFlow(a.services, relayed(a.facts));
    expect(refused).toMatchObject({ state: "FAILED", failedReason: expect.stringMatching(/not verified/) });
    expect(a.prover.proofs, "nothing proved").toHaveLength(0);
    expect(a.transport.posted, "nothing sent").toEqual([]);
    const honest = other(true);
    const b = await ready({ secondOpinion: honest.rpc });
    expect(b.services.histories.get("eth-100")!.status).toMatchObject({ kind: "ready", verified: true });
    const asked = honest.seen.length;
    const done = await withdrawalFlow(b.services, relayed(b.facts));
    expect(done.state, done.failedReason ?? "").toBe("COMPLETED");
    expect(honest.seen.length, "the second endpoint hears nothing at the withdrawal's moment").toBe(asked);
    for (const c of [...lying.seen, ...honest.seen].filter((c) => c.method === "eth_call")) {
      expect((c.params[0] as { data: string }).data.startsWith(VIEW.isSpent), "never told the nullifier hash in relayer mode").toBe(false);
      expect(c.params[1], "every read names the history's block, never the latest").not.toBe("latest");
    }
  });

  it("the proof submitted is the one confirmed (the eleventh review round, C11-3): a proof made again after the confirmation that pays another relayer account sends nothing", async () => {
    const { services, transport, facts, chain } = await ready();
    let asked = 0;
    const job = await withdrawalFlow(services, {
      pool: "eth-100",
      note: NOTE,
      facts,
      recipient: RECIPIENT,
      via: "relayer",
      relayerId: "to-relayer.eth",
      feeWei: FEE,
      confirm: async () => {
        // the root ages out while the user reads the confirmation, and the directory's entry is refreshed with another account meanwhile
        chain.options.knownRoots = () => [false, true][asked++] ?? true;
        const entry = services.relayers.entry("to-relayer.eth")!;
        entry.facts = { ...entry.facts!, rewardAccount: "0x2222222222222222222222222222222222222222" }; // what a refresh of its status does
        return true;
      },
    });
    expect(job.state, job.failedReason ?? "").toBe("COMPLETED");
    expect(transport.posted, "the proof made again pays the account copied once, before the confirmation").toHaveLength(1);
    const posted = transport.posted[0] as { body: { args: string[] } };
    expect(BigInt(posted.body.args[3])).toBe(BigInt(status.v4.body.rewardAccount));
  });

  it("a relayer's CONFIRMED while the pool does not show the note spent is the relayer's report: the record waits, History says so (the tenth review round, C10-3)", async () => {
    const { services, chain, facts } = await ready();
    chain.options.spent = false; // the relayer answers CONFIRMED and sent nothing
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
    expect(job).toMatchObject({ state: "SOURCE_CONFIRMING", relayerState: "CONFIRMED" });
    expect(job.spentUnread, "the pool was asked and answered (the critique)").toBeUndefined();
    expect((await sourceOfServices(services).history())[0]).toMatchObject({ status: "reported" });
  });

  it("the confirmation is asked with the terms the proof pays, from its own public signals (the tenth review round, C10-1)", async () => {
    const { services, facts } = await ready();
    const asked: unknown[] = [];
    await withdrawalFlow(services, {
      pool: "eth-100",
      note: NOTE,
      facts,
      recipient: RECIPIENT,
      via: "relayer",
      relayerId: "to-relayer.eth",
      feeWei: FEE,
      confirm: async (terms) => {
        asked.push(terms);
        return false;
      },
    });
    expect(asked).toEqual([{ recipient: RECIPIENT, relayer: status.v4.body.rewardAccount.toLowerCase(), feeWei: FEE, refundWei: 0n }]);
  });

  it("with the sanctions oracle switched on, the sending account is screened right before each send (the tenth review round, C10-9): listed or unanswered refuses, clear sends", async () => {
    const listed = await setup({ oracle: "listed" });
    expect(await depositFlow(listed.services, { pool: "eth-100", note: NOTE })).toMatchObject({
      state: "FAILED",
      failedReason: expect.stringMatching(/cannot use the interface/),
    });
    expect(listed.provider.sent).toEqual([]);
    const down = await setup({ oracle: "unreachable" });
    expect(await depositFlow(down.services, { pool: "eth-100", note: NOTE })).toMatchObject({
      state: "FAILED",
      failedReason: expect.stringMatching(/could not be completed/),
    });
    expect(down.provider.sent).toEqual([]);
    const clear = await setup({ oracle: "clear" });
    expect((await depositFlow(clear.services, { pool: "eth-100", note: NOTE })).state).toBe("COMPLETED");
    expect(clear.provider.sent).toHaveLength(1);
  });

  it("a deposit's receipt is asked of the connected wallet, never the app's endpoint (the tenth review round, C10-12); a wallet that answers none leaves it to the endpoint", async () => {
    const own = await setup();
    expect((await depositFlow(own.services, { pool: "eth-100", note: NOTE })).state).toBe("COMPLETED");
    expect(
      own.chain.seen.some((c) => c.method === "eth_getTransactionReceipt"),
      "the endpoint never saw the deposit's hash",
    ).toBe(false);
    const mute = await setup({ walletReceipts: "none" });
    expect((await depositFlow(mute.services, { pool: "eth-100", note: NOTE })).state).toBe("COMPLETED");
    expect(mute.chain.seen.some((c) => c.method === "eth_getTransactionReceipt")).toBe(true);
  });

  it("a lookup's miss says what the history knows (the tenth review round, C10-2): synced again and missed in a verified history → no deposit up to its block; a history that failed, or that the chain did not agree with → the note could not be checked", async () => {
    const other = generateNote("eth", "100", 1, seeded(7));
    const ok = await setup({ realCommitments: true });
    await ok.services.histories.get("eth-100")!.ensure();
    const synced = ok.chain.seen.filter((c) => c.method === "eth_getLogs").length;
    ok.chain.options.head += 50;
    expect(await sourceOf(ok.services).lookup(other)).toMatchObject({ kind: "no-deposit", toBlock: expect.any(Number) });
    expect(ok.chain.seen.filter((c) => c.method === "eth_getLogs").length, "synced again before the answer").toBeGreaterThan(synced);
    const failed = await setup({ realCommitments: true, logsFail: true });
    expect(await sourceOf(failed.services).lookup(other)).toEqual({ kind: "history-unavailable" });
    const unverified = await setup({ realCommitments: true, knownRoot: false });
    expect(await sourceOf(unverified.services).lookup(other)).toEqual({ kind: "history-unverified" });
  });

  it("a relayer's or a wallet's free text is kept as one short plain line (the tenth review round, C10-15)", () => {
    expect(plainText("bad\n\u0007proof\u202e   here")).toBe("bad proof here");
    expect(plainText("x".repeat(500))).toHaveLength(160);
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
    const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" as const; // a token's own contract that takes ETH (the tenth review round, C10-8)
    for (const recipient of ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dEaD", POOL_100, ROUTER, WETH] as const) {
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
      await expect(refused).rejects.toThrow(
        /the zero address, a burn address, a contract of the pools or a token's own contract: a withdrawal sent there is lost/,
      );
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
        return true;
      },
    });
    expect(job.state).toBe("FAILED");
    expect(job.failedReason).toMatch(/not among the pool's last hundred even after the history was synced and the proof made again: nothing is sent/);
    expect(prover.proofs.length).toBe(2);
    expect(transport.posted).toHaveLength(0);
  });

  it("wallet mode asks a second endpoint before sending (the fifth review round, 2026-11-03): one that does not know the root, or calls the note spent, stops the send; one that agrees lets it through, and the prover is closed after the record", async () => {
    const other = (o: { knownRoot: boolean; spent?: boolean }) =>
      scriptedChain({
        head: snap.manifest.toBlock + 200,
        logs: [[]],
        nextIndex: 1024,
        knownRoot: o.knownRoot,
        spent: o.spent ?? false,
        blockHashes: { [snap.manifest.toBlock]: snap.manifest.blockHash! },
      }).rpc;
    const input = (facts: Parameters<typeof withdrawalFlow>[1]["facts"]) => ({
      pool: "eth-100" as const,
      note: NOTE,
      facts,
      recipient: RECIPIENT,
      via: "wallet" as const,
      confirm: async () => true,
    });
    // a second endpoint that does not know the root disagrees at the history's sync (the eleventh review round, C11-12): nothing is proved
    const a = await ready({ secondOpinion: other({ knownRoot: false }) });
    const refused = await withdrawalFlow(a.services, input(a.facts));
    expect(refused.state).toBe("FAILED");
    expect(refused.failedReason).toMatch(/not verified/);
    expect(a.prover.proofs).toHaveLength(0);
    expect(a.provider.sent, "nothing sent").toEqual([]);
    const b = await ready({ secondOpinion: other({ knownRoot: true, spent: true }) });
    const spent = await withdrawalFlow(b.services, input(b.facts));
    expect(spent.state).toBe("FAILED");
    expect(spent.failedReason).toMatch(/second RPC endpoint reports this note as spent/);
    expect(b.provider.sent).toEqual([]);
    const c = await ready({ secondOpinion: other({ knownRoot: true }) });
    const done = await withdrawalFlow(c.services, input(c.facts));
    expect(done.state, done.failedReason ?? "").toBe("COMPLETED");
    expect(c.provider.sent).toHaveLength(1);
    expect(c.prover.closed, "the prover worker is closed once the record is terminal").toBeGreaterThanOrEqual(1);
    expect(a.prover.closed, "and after a refused one").toBeGreaterThanOrEqual(1);
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

describe("the eleventh review round's critique of the Classic flows (2026-11-05)", () => {
  const OTHER = "0x8589427373d6d84e98730d7795d8f6f8731fda16" as const;
  /** the account the proof pays its relayer: the pool's Withdrawal event names it */
  const PAID = status.v4.body.rewardAccount.toLowerCase() as `0x${string}`;
  async function found(over: Parameters<typeof setup>[0] = {}) {
    const s = await setup(over);
    await s.services.relayers.refresh();
    await s.services.histories.get("eth-100")!.ensure();
    const lookup = await sourceOf(s.services).lookup(NOTE);
    if (lookup.kind !== "found") throw new Error(`the note was not found: ${lookup.kind}`);
    return { ...s, facts: lookup.facts };
  }
  type Facts = Parameters<typeof withdrawalFlow>[1]["facts"];
  const relayed = (facts: Facts, confirm: () => Promise<boolean> = async () => true) => ({
    pool: "eth-100" as const,
    note: NOTE,
    facts,
    recipient: RECIPIENT,
    via: "relayer" as const,
    relayerId: "to-relayer.eth",
    feeWei: FEE,
    confirm,
  });
  const walletMode = (facts: Facts) => ({
    pool: "eth-100" as const,
    note: NOTE,
    facts,
    recipient: RECIPIENT,
    via: "wallet" as const,
    confirm: async () => true,
  });
  const nullifierHashOf = async (prover: ReturnType<typeof fakeProver>["prover"]) => {
    const derived = await prover.note(formatNote(NOTE));
    if (!derived.ok) throw new Error("the note is not readable");
    return derived.nullifierHash;
  };
  const spentReads = (seen: { method: string; params: unknown[] }[]) =>
    seen.filter((c) => c.method === "eth_call" && (c.params[0] as { data: string }).data.startsWith(VIEW.isSpent));

  it("the note's keyed digest is kept from the submission on, never before: a flow cancelled at its confirmation never kept one; a lost answer keeps it, and History settles that record only on its own note's Withdrawal event (C11-1, VC-N1)", async () => {
    const cancelled = await found();
    const seen: JobRecord[] = [];
    expect((await withdrawalFlow(cancelled.services, { ...relayed(cancelled.facts, async () => false), onJob: (j) => seen.push(j) })).state).toBe("CANCELLED");
    expect(seen.length).toBeGreaterThan(2);
    expect(
      seen.filter((j) => j.noteDigest !== undefined),
      "no record before the submission keeps the note's digest",
    ).toEqual([]);
    const lost = await found();
    lost.transport.postJson = async () => {
      throw new Error("The operation was aborted");
    };
    const kept: JobRecord[] = [];
    const job = await withdrawalFlow(lost.services, { ...relayed(lost.facts), onJob: (j) => kept.push(j) });
    expect(job.state).toBe("RECOVERY_REQUIRED");
    expect(kept.find((j) => j.noteDigest !== undefined)?.state, "first kept at the submission").toBe("SUBMITTING");
    const nh = await nullifierHashOf(lost.prover);
    const [open] = await lost.services.jobs.list();
    expect(open.noteDigest).toBe(noteDigestOf(open.id, nh));
    expect(open.fromBlock, "the history's block at the submission: the note's event comes after it").toBe(
      lost.services.histories.get("eth-100")!.state!.toBlock,
    );
    expect(open.relayerAccount, "the account the proof pays: only its withdrawal of the note completes the record").toBe(PAID);
    // another note's withdrawal of the pool settles nothing, nor this note's through another relayer (the critique); this note's through its own does
    lost.chain.options.head = snap.manifest.toBlock + 400;
    lost.chain.options.logs = [
      [
        withdrawalLog(POOL_100, hex32(4243n), snap.manifest.toBlock + 300, { txHash: hex32(779n), relayer: PAID }),
        withdrawalLog(POOL_100, nh, snap.manifest.toBlock + 310, { txHash: hex32(784n), relayer: OTHER }),
      ],
    ];
    await lost.services.histories.get("eth-100")!.refresh();
    expect((await sourceOf(lost.services).history())[0]).toMatchObject({ status: "unknown" });
    lost.chain.options.head = snap.manifest.toBlock + 600;
    lost.chain.options.logs = [[withdrawalLog(POOL_100, nh, snap.manifest.toBlock + 500, { txHash: hex32(780n), relayer: PAID })]];
    await lost.services.histories.get("eth-100")!.refresh();
    expect((await sourceOf(lost.services).history())[0]).toMatchObject({ status: "withdrawn", txHash: hex32(780n) });
    expect((await lost.services.jobs.list())[0].noteDigest).toBeUndefined();
  });

  it("a relayed flow that ends — completed, or refused by the relayer — keeps no digest (C11-1)", async () => {
    const done = await found();
    expect((await withdrawalFlow(done.services, relayed(done.facts))).state).toBe("COMPLETED");
    expect((await done.services.jobs.list())[0].noteDigest).toBeUndefined();
    const refused = await found();
    refused.transport.postJson = async () => ({ status: 400, body: { error: "the fee is too low" } });
    expect(await withdrawalFlow(refused.services, relayed(refused.facts))).toMatchObject({
      state: "FAILED",
      failedReason: expect.stringMatching(/fee is too low/),
    });
    expect((await refused.services.jobs.list())[0].noteDigest).toBeUndefined();
  });

  it("a relayer's FAILED for a note the pool reports spent waits for a look on chain — in the flow, in History, and after History asked the relayer again; the note's Withdrawal event completes it (C11-13)", async () => {
    const s = await found({ jobStates: ["QUEUED", "FAILED"] });
    expect(await withdrawalFlow(s.services, relayed(s.facts))).toMatchObject({ state: "RECOVERY_REQUIRED", relayerState: "FAILED" });
    expect((await sourceOf(s.services).history())[0].status, "never Failed").toBe("unknown");
    const nh = await nullifierHashOf(s.prover);
    const [kept] = await s.services.jobs.list();
    expect(kept.state, "History asked the relayer again: the record stays open").toBe("RECOVERY_REQUIRED");
    expect(kept.noteDigest).toBe(noteDigestOf(kept.id, nh));
    // the relayer restarted and forgot the job: the note's own Withdrawal event completes the record all the same (the critique)
    const get = s.transport.getJson.bind(s.transport);
    s.transport.getJson = async (url: string) => (url.includes("/v1/jobs/") ? { status: 400, body: { error: "no such job" } } : get(url));
    s.chain.options.head = snap.manifest.toBlock + 400;
    s.chain.options.logs = [[withdrawalLog(POOL_100, nh, snap.manifest.toBlock + 300, { txHash: hex32(781n), relayer: PAID })]];
    await s.services.histories.get("eth-100")!.refresh();
    expect((await sourceOf(s.services).history())[0]).toMatchObject({ status: "withdrawn", txHash: hex32(781n) });
    const [settled] = await s.services.jobs.list();
    expect(settled).toMatchObject({ state: "COMPLETED", relayerState: "FAILED" });
    expect(settled.noteDigest).toBeUndefined();
  });

  it("the note's Withdrawal event completes a FAILED-but-spent record while the relayer still answers FAILED, and the relayer is not asked once the event is found (the critique of C11-13)", async () => {
    const s = await found({ jobStates: ["QUEUED", "FAILED"] });
    expect(await withdrawalFlow(s.services, relayed(s.facts))).toMatchObject({ state: "RECOVERY_REQUIRED", relayerState: "FAILED" });
    await sourceOf(s.services).history(); // the relayer asked again: FAILED, the record kept open
    const nh = await nullifierHashOf(s.prover);
    const jobReads: string[] = [];
    const get = s.transport.getJson.bind(s.transport);
    s.transport.getJson = async (url: string) => {
      if (url.includes("/v1/jobs/")) jobReads.push(url);
      return get(url);
    };
    s.chain.options.head = snap.manifest.toBlock + 400;
    s.chain.options.logs = [[withdrawalLog(POOL_100, nh, snap.manifest.toBlock + 300, { txHash: hex32(783n), relayer: PAID })]];
    await s.services.histories.get("eth-100")!.refresh();
    expect((await sourceOf(s.services).history())[0]).toMatchObject({ status: "withdrawn", txHash: hex32(783n) });
    const [settled] = await s.services.jobs.list();
    expect(settled).toMatchObject({ state: "COMPLETED" });
    expect(settled.noteDigest).toBeUndefined();
    expect(jobReads, "the relayer is not asked once the note's event is found").toEqual([]);
  });

  it("History reads a record's note event from the record's own block on, paid to its own relayer (the critique: the bound had been tested at its ends only)", async () => {
    const s = await setup();
    await s.services.histories.get("eth-100")!.ensure();
    const h = s.services.histories.get("eth-100")!;
    const fromBlock = h.state!.toBlock;
    const now = s.services.now();
    await s.services.jobs.put({
      id: "jb",
      kind: "withdrawal",
      pool: "eth-100",
      state: "RECOVERY_REQUIRED",
      createdAt: now,
      updatedAt: now,
      via: "relayer",
      relayerUrl: "https://eth.to-relayer.com",
      noteDigest: noteDigestOf("jb", hex32(4246n)),
      fromBlock,
      relayerAccount: PAID,
    });
    const calls: unknown[][] = [];
    const find = h.findWithdrawal.bind(h);
    h.findWithdrawal = (...a: Parameters<typeof find>) => {
      calls.push(a.slice(1));
      return find(...a);
    };
    await sourceOfServices(s.services).history();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.slice(1), "the record's block and relayer").toEqual([fromBlock, PAID]);
    // records with a relayer job: the settling before the relayer is asked, then — the relayer answering CONFIRMED — its transaction's match
    calls.length = 0;
    await s.services.jobs.clear();
    const get = s.transport.getJson.bind(s.transport);
    s.transport.getJson = async (url: string) =>
      url.includes("/v1/jobs/")
        ? {
            status: 200,
            body: { id: "job-1", type: "TORNADO_WITHDRAW", status: "CONFIRMED", txHash: hex32(790n), confirmations: 4, failedReason: null },
          }
        : get(url);
    for (const [id, state] of [
      ["jc", "SOURCE_CONFIRMING"],
      ["jd", "RECOVERY_REQUIRED"],
    ] as const)
      await s.services.jobs.put({
        id,
        kind: "withdrawal",
        pool: "eth-100",
        state,
        createdAt: now,
        updatedAt: now,
        via: "relayer",
        relayerUrl: "https://eth.to-relayer.com",
        relayerJobId: "job-1",
        relayerState: "SENT",
        noteDigest: noteDigestOf(id, hex32(4247n)),
        fromBlock,
        relayerAccount: PAID,
      });
    await sourceOfServices(s.services).history();
    expect(calls.length, "both sites, for both records").toBe(4);
    for (const c of calls) expect(c.slice(1), "the record's block and relayer at every site").toEqual([fromBlock, PAID]);
  });

  it("a FAILED-but-spent record with its relayer job is completed only by its note's withdrawal through its own relayer (the critique)", async () => {
    const s = await found({ jobStates: ["QUEUED", "FAILED"] });
    expect(await withdrawalFlow(s.services, relayed(s.facts))).toMatchObject({ state: "RECOVERY_REQUIRED", relayerJobId: "job-1" });
    const nh = await nullifierHashOf(s.prover);
    s.chain.options.head = snap.manifest.toBlock + 400;
    s.chain.options.logs = [[withdrawalLog(POOL_100, nh, snap.manifest.toBlock + 300, { txHash: hex32(785n), relayer: OTHER })]];
    await s.services.histories.get("eth-100")!.refresh();
    expect((await sourceOf(s.services).history())[0].status, "another relayer's withdrawal of the note completes nothing").toBe("unknown");
    s.chain.options.head = snap.manifest.toBlock + 600;
    s.chain.options.logs = [[withdrawalLog(POOL_100, nh, snap.manifest.toBlock + 500, { txHash: hex32(786n), relayer: PAID })]];
    await s.services.histories.get("eth-100")!.refresh();
    expect((await sourceOf(s.services).history())[0]).toMatchObject({ status: "withdrawn", txHash: hex32(786n) });
  });

  it("with one endpoint, a history whose root aged out before the click is synced before the proof: one proof, on the new root (the critique)", async () => {
    const s = await found();
    const oldRoot = s.services.histories.get("eth-100")!.currentRoot()!.toLowerCase();
    s.chain.options.head = snap.manifest.toBlock + 300;
    s.chain.options.logs = [[depositLog(POOL_100, 1024, 777_777n, snap.manifest.toBlock + 250)]];
    s.chain.options.nextIndex = 1025;
    s.chain.options.knownRoots = (root) => root.toLowerCase() !== oldRoot;
    const job = await withdrawalFlow(s.services, relayed(s.facts));
    expect(job.state, job.failedReason ?? "").toBe("COMPLETED");
    expect(s.prover.proofs, "one proof").toHaveLength(1);
    expect(BigInt(s.prover.proofs[0].root), "on the new root").not.toBe(BigInt(oldRoot));
    expect(s.services.histories.get("eth-100")!.state!.leaves).toBe(1025);
  });

  it("a refusal keeps its catalog words beside its English reason (the critique: the new ones had reached a Korean reader in English)", async () => {
    const second = scriptedChain({
      head: snap.manifest.toBlock + 200,
      logs: [[]],
      nextIndex: 1024,
      knownRoot: true,
      calls: PIN_CALLS,
      blockHashes: { [snap.manifest.toBlock]: snap.manifest.blockHash! },
    });
    const mute: Rpc = async (method, params) => {
      if (method === "eth_call" && (params[0] as { data: string }).data.startsWith(VIEW.isSpent)) throw new Error("HTTP 429");
      return second.rpc(method, params);
    };
    const s = await found({ secondOpinion: mute });
    expect(await withdrawalFlow(s.services, walletMode(s.facts))).toMatchObject({ state: "FAILED", failedKey: "refusal.secondSilentSpent" });
    const u = await found({
      secondOpinion: scriptedChain({
        head: snap.manifest.toBlock + 200,
        logs: [[]],
        nextIndex: 1024,
        knownRoot: true,
        spent: true,
        calls: PIN_CALLS,
        blockHashes: { [snap.manifest.toBlock]: snap.manifest.blockHash! },
      }).rpc,
    });
    expect(await withdrawalFlow(u.services, walletMode(u.facts))).toMatchObject({ state: "FAILED", failedKey: "refusal.secondSaysSpent" });
  });

  it("a prover that fails at the note's hashes leaves no record: they come before the draft (C11-8)", async () => {
    const { prover } = fakeProver({ commitmentFor: () => deposits[5].commitment });
    const s = await found({ prover });
    prover.note = async () => {
      throw new Error("the prover was closed");
    };
    await expect(withdrawalFlow(s.services, relayed(s.facts))).rejects.toThrow(/prover was closed/);
    expect(await s.services.jobs.list(), "no record left at PREPARING_PROOF").toEqual([]);
  });

  it("wallet mode screens the sending account before any read names the note's nullifier hash (C11-13)", async () => {
    const s = await found({ oracle: "listed" });
    expect(await withdrawalFlow(s.services, walletMode(s.facts))).toMatchObject({
      state: "FAILED",
      failedReason: expect.stringMatching(/cannot use the interface/),
    });
    expect(spentReads(s.chain.seen), "the endpoint was never told the nullifier hash").toEqual([]);
    expect(s.provider.sent).toEqual([]);
  });

  it("an account the wallet switched to while the oracle was read sends nothing — a deposit, or a wallet-mode withdrawal (C11-7)", async () => {
    type Listeners = { listeners: Record<string, ((...a: unknown[]) => void)[]> };
    const switching =
      (provider: () => Listeners) =>
      (rpc: Rpc): Rpc =>
      async (method, params) => {
        if (method === "eth_call" && (params[0] as { data: string }).data.startsWith(sel("isSanctioned(address)")))
          for (const l of provider().listeners.accountsChanged ?? []) l([OTHER]);
        return rpc(method, params);
      };
    let depositWallet: Listeners | null = null;
    const d = await setup({ oracle: "clear", rpcWrap: switching(() => depositWallet!) });
    depositWallet = d.provider;
    expect((await depositFlow(d.services, { pool: "eth-100", note: NOTE })).state).toBe("FAILED");
    expect(d.provider.sent, "nothing sent from the account nobody screened").toEqual([]);
    let withdrawWallet: Listeners | null = null;
    const w = await found({ oracle: "clear", rpcWrap: switching(() => withdrawWallet!) });
    withdrawWallet = w.provider;
    expect((await withdrawalFlow(w.services, walletMode(w.facts))).state).toBe("FAILED");
    expect(w.provider.sent, "nothing sent from the account nobody screened").toEqual([]);
  });

  it("a relayer the directory turned offline during the confirmation — its status names another account — is sent nothing (C11-3)", async () => {
    const s = await found();
    const get = s.transport.getJson.bind(s.transport);
    const job = await withdrawalFlow(
      s.services,
      relayed(s.facts, async () => {
        s.transport.getJson = async (url: string) =>
          url.endsWith("/v1/status") ? { status: 200, body: { ...status.v4.body, rewardAccount: "0x2222222222222222222222222222222222222222" } } : get(url);
        await s.services.relayers.refreshOne("to-relayer.eth");
        return true;
      }),
    );
    expect(s.services.relayers.entry("to-relayer.eth")!.status).toBe("offline");
    expect(job).toMatchObject({ state: "FAILED", failedReason: expect.stringMatching(/no longer online/) });
    expect(s.transport.posted).toEqual([]);
  });

  it("with a second endpoint, a relayed withdrawal whose root aged out during its confirmation is refused — never proved again on a refresh it made itself — and the second endpoint hears nothing meanwhile; the next attempt, on a history synced again with both, completes (C11-9 and its critique)", async () => {
    const oldRoot = snap.manifest.root.toLowerCase();
    const second = scriptedChain({
      head: snap.manifest.toBlock + 200,
      logs: [[]],
      nextIndex: 1024,
      knownRoot: true,
      calls: PIN_CALLS,
      blockHashes: { [snap.manifest.toBlock]: snap.manifest.blockHash! },
    });
    const s = await found({ secondOpinion: second.rpc });
    expect(s.services.histories.get("eth-100")!.status).toMatchObject({ kind: "ready", verified: true });
    let atConfirmation = -1;
    const job = await withdrawalFlow(
      s.services,
      relayed(s.facts, async () => {
        // the root ages out of the pool's hundred during the confirmation (Stage 10's scenario), both endpoints honest
        s.chain.options.head = snap.manifest.toBlock + 300;
        s.chain.options.logs = [[depositLog(POOL_100, 1024, 777_777n, snap.manifest.toBlock + 250)]];
        s.chain.options.nextIndex = 1025;
        s.chain.options.knownRoots = (root) => root.toLowerCase() !== oldRoot;
        second.options.nextIndex = 1025;
        second.options.knownRoots = (root) => root.toLowerCase() !== oldRoot;
        atConfirmation = second.seen.length;
        return true;
      }),
    );
    expect(job).toMatchObject({
      state: "FAILED",
      failedReason: "the pool's last hundred roots moved on during the withdrawal: nothing is sent; start the withdrawal again",
      failedKey: "refusal.rootsMovedDuring",
    });
    expect(second.seen.slice(atConfirmation), "nothing asked of the second endpoint after the confirmation").toEqual([]);
    expect(s.transport.posted, "nothing sent").toEqual([]);
    // the next attempt syncs first — the history was marked stale —, both endpoints asked, before any record of it; nothing while it runs
    const asked = second.seen.length;
    let atFirstRecord = -1;
    const again = await withdrawalFlow(s.services, {
      ...relayed(s.facts),
      onJob: () => {
        if (atFirstRecord < 0) atFirstRecord = second.seen.length;
      },
    });
    expect(atFirstRecord, "the sync before the attempt asked the second endpoint").toBeGreaterThan(asked);
    expect(second.seen.length, "and the attempt asked it nothing").toBe(atFirstRecord);
    expect(s.services.histories.get("eth-100")!.status).toMatchObject({ kind: "ready", verified: true, leaves: 1025 });
    expect(again.state, again.failedReason ?? "").toBe("COMPLETED");
    const posted = s.transport.posted[0] as { body: { args: string[] } };
    expect(posted.body.args[0].toLowerCase(), "proved on the new root").not.toBe(oldRoot);
  });

  it("in wallet mode with a second endpoint, a root aged out during the confirmation is proved again on a refresh that asks both endpoints, then sent (the critique of C11-9)", async () => {
    const oldRoot = snap.manifest.root.toLowerCase();
    const second = scriptedChain({
      head: snap.manifest.toBlock + 200,
      logs: [[]],
      nextIndex: 1024,
      knownRoot: true,
      calls: PIN_CALLS,
      blockHashes: { [snap.manifest.toBlock]: snap.manifest.blockHash! },
    });
    const s = await found({ secondOpinion: second.rpc });
    let atConfirmation = -1;
    const job = await withdrawalFlow(s.services, {
      ...walletMode(s.facts),
      confirm: async () => {
        s.chain.options.head = snap.manifest.toBlock + 300;
        s.chain.options.logs = [[depositLog(POOL_100, 1024, 777_777n, snap.manifest.toBlock + 250)]];
        s.chain.options.nextIndex = 1025;
        s.chain.options.knownRoots = (root) => root.toLowerCase() !== oldRoot;
        second.options.nextIndex = 1025;
        second.options.knownRoots = (root) => root.toLowerCase() !== oldRoot;
        atConfirmation = second.seen.length;
        return true;
      },
    });
    expect(job.state, job.failedReason ?? "").toBe("COMPLETED");
    expect(s.provider.sent).toHaveLength(1);
    const after = second.seen.slice(atConfirmation);
    expect(
      after.filter((c) => c.method === "eth_call" && (c.params[0] as { data: string }).data.startsWith(VIEW.isKnownRoot)).length,
      "the refresh held the new root to the second endpoint too",
    ).toBeGreaterThan(0);
    expect(spentReads(after), "and its spent bit, right before the send").toHaveLength(1);
  });

  it("in wallet mode, a lying first endpoint that calls the proof's root unknown and vouches for a deposit of its own cannot have the wallet send: the refresh asks the second, which does not agree (the critique of C11-9)", async () => {
    const oldRoot = snap.manifest.root.toLowerCase();
    const second = scriptedChain({
      head: snap.manifest.toBlock + 200,
      logs: [[]],
      nextIndex: 1024,
      knownRoot: true,
      calls: PIN_CALLS,
      blockHashes: { [snap.manifest.toBlock]: snap.manifest.blockHash! },
    });
    const s = await found({ secondOpinion: second.rpc });
    const job = await withdrawalFlow(s.services, {
      ...walletMode(s.facts),
      confirm: async () => {
        s.chain.options.head = snap.manifest.toBlock + 300;
        s.chain.options.logs = [[depositLog(POOL_100, 1024, 666_666n, snap.manifest.toBlock + 250)]];
        s.chain.options.nextIndex = 1025;
        s.chain.options.knownRoots = (root) => root.toLowerCase() !== oldRoot;
        return true;
      },
    });
    expect(job).toMatchObject({ state: "FAILED", failedReason: "the history is not verified" });
    expect(s.provider.sent, "the wallet asked to send nothing").toEqual([]);
    const h = s.services.histories.get("eth-100")!;
    expect(h.status).toMatchObject({ kind: "ready", verified: false, reason: "the second RPC endpoint does not agree with this history at its block" });
    expect(h.state?.verified, "never stored as verified").toBeUndefined();
  });

  it("wallet mode: a second endpoint that does not answer the spent read stops the send, saying it did not answer — never that the endpoints disagree (the critique of C11-12)", async () => {
    const honest = scriptedChain({
      head: snap.manifest.toBlock + 200,
      logs: [[]],
      nextIndex: 1024,
      knownRoot: true,
      calls: PIN_CALLS,
      blockHashes: { [snap.manifest.toBlock]: snap.manifest.blockHash! },
    });
    const mute: Rpc = async (method, params) => {
      if (method === "eth_call" && (params[0] as { data: string }).data.startsWith(VIEW.isSpent)) throw new Error("HTTP 429");
      return honest.rpc(method, params);
    };
    const first = scriptedChain({
      head: snap.manifest.toBlock + 200,
      logs: [[]],
      nextIndex: 1024,
      knownRoot: true,
      calls: PIN_CALLS,
      blockHashes: { [snap.manifest.toBlock]: snap.manifest.blockHash! },
    });
    const s = await found({ secondOpinion: mute, firstOpinion: first.rpc });
    expect(await withdrawalFlow(s.services, walletMode(s.facts))).toMatchObject({
      state: "FAILED",
      failedReason: "the second RPC endpoint did not answer whether this note is spent: nothing is sent; try again later",
    });
    expect(s.provider.sent).toEqual([]);
    // the spent bit asked of the first endpoint alone, never of the endpoints that fail over (the critique of C11-12)
    expect(spentReads(first.seen)).toHaveLength(1);
    expect(spentReads(s.chain.seen)).toEqual([]);
  });

  it("a relayed record still submitting with no job past SUBMISSION_LOST_MS — its page closed during the submission — reads Outcome unknown, and is settled once the pool's Withdrawal events name its note (the critique of VC-N1)", async () => {
    const s = await setup();
    const now = s.services.now();
    const record = (id: string, updatedAt: number, nh: bigint): JobRecord => ({
      id,
      kind: "withdrawal",
      pool: "eth-100",
      state: "SUBMITTING",
      createdAt: updatedAt,
      updatedAt,
      via: "relayer",
      relayerUrl: "https://eth.to-relayer.com",
      noteDigest: noteDigestOf(id, hex32(nh)),
    });
    await s.services.jobs.put(record("fresh", now - 5_000, 4245n));
    await s.services.jobs.put(record("gone", now - SUBMISSION_LOST_MS - 1, 4244n));
    const rows = await sourceOfServices(s.services).history();
    expect(rows.find((r) => r.id === "fresh")!.status, "a submission may still be under way").toBe("waiting");
    expect(rows.find((r) => r.id === "gone")!.status).toBe("unknown");
    expect((await s.services.jobs.list()).find((j) => j.id === "gone")).toMatchObject({
      state: "RECOVERY_REQUIRED",
      failedReason: expect.stringMatching(/page closed before the relayer's answer arrived/),
    });
    s.chain.options.head = snap.manifest.toBlock + 400;
    s.chain.options.logs = [[withdrawalLog(POOL_100, hex32(4244n), snap.manifest.toBlock + 300, { txHash: hex32(782n) })]];
    await s.services.histories.get("eth-100")!.refresh();
    const after = await sourceOfServices(s.services).history();
    expect(after.find((r) => r.id === "gone")).toMatchObject({ status: "withdrawn", txHash: hex32(782n) });
    expect(after.find((r) => r.id === "fresh")!.status, "another note's event settles nothing").toBe("waiting");
    expect(s.transport.posted, "read, never sent").toEqual([]);
  });
});
