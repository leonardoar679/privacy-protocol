// Tornado Classic on a fork of Ethereum mainnet (V7 Stage 10; spec v3.0 §7.9): the real pools, router and registries with
// their real state, a Hardhat node forking mainnet (`npx hardhat node --port 8547 --fork <mainnet rpc>` from
// scripts/local-stack), the app's services in this process — the served snapshot of the 100 ETH pool held to its manifest
// and the delta synced onto it, the pins verified against the fork, a 100 ETH deposit through the router from one of the
// fork's accounts, the note found in the synced history, a proof in Node, the withdrawal through the router by a relayer
// stand-in (as the relayer software does), the recipient paid and the note spent on chain; then the root aging out of the
// pool's hundred between the proof and the confirmation (a hundred more deposits), proved again on the fresh history and
// withdrawn in wallet mode. Opt-in: CLASSIC_FORK_RPC names the fork node; the snapshot under public/data/eth-100
// (`npm run snapshot -- --pool eth-100`) and the artifacts under public/artifacts must be on this machine. The same suite
// runs against the local stack's devnet (CLASSIC_FORK_RPC=http://127.0.0.1:8546 after scripts/local-stack/deploy.mjs): the
// pools are empty there, so the history builds from the block the contracts were placed at (run/stack.json, or
// CLASSIC_DEVNET_DEPLOYED_BLOCK) instead of the served snapshot — the devnet mode. Hardhat or Ganache: the node's own
// accounts, its balance and mining calls.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withdrawalFlow, depositFlow } from "../../src/app/services/flows";
import { createServices, type ClassicServices } from "../../src/app/services/source";
import { WalletSession } from "../../src/app/services/wallet";
import { configFromEnv } from "../../src/config";
import { decodeLogs, type Hex, type RawLog } from "../../src/history/events";
import type { SnapshotManifest, SnapshotTexts } from "../../src/history/snapshot";
import { isSpentOnChain } from "../../src/history/spent";
import { feeLines } from "../../src/model/fees";
import { formatNote, generateNote, type ClassicNote } from "../../src/model/notes";
import { DEPLOYMENT, POOLS, poolOf } from "../../src/model/pools";
import type { DepositFacts } from "../../src/model/types";
import { makeRpc } from "../../src/net/rpc";
import type { RelayerAnswer, RelayerTransport } from "../../src/relayer/client";
import { WithdrawRequestSchema } from "../../src/relayer/schema";
import { memoryHistoryStore, memoryJobsStore } from "../../src/storage/historyDb";
import { encodePoolDeposit, encodeRouterWithdraw } from "../../src/wallet/calldata";
import type { Eip1193Provider } from "../../src/wallet/injected";
import { ARTIFACTS_DIR, nodeProver, type NodeProver } from "../helpers/nodeProver";

const FORK = process.env.CLASSIC_FORK_RPC;
const SNAPSHOT = process.env.CLASSIC_FORK_SNAPSHOT ?? join(__dirname, "..", "..", "public", "data", "eth-100");
const ready = !!FORK && existsSync(join(ARTIFACTS_DIR, "tornadoProvingKey.bin"));
if (!ready) console.info(`fork suite skipped: ${!FORK ? "CLASSIC_FORK_RPC not set" : "no artifacts under public/artifacts"}`);
console.info(
  `fork suite skipped: ${!FORK ? "CLASSIC_FORK_RPC not set" : !existsSync(join(SNAPSHOT, "manifest.json")) ? `no snapshot under ${SNAPSHOT}` : "no artifacts under public/artifacts"}`,
);

// the node's own unlocked accounts (Hardhat's or Ganache's): #0 deposits, #1 is the relayer stand-in, #2 floods the pool
const ACCOUNTS: Hex[] = [];
/** the devnet's knobs, as Hardhat or Ganache name them */
const devnet = {
  kind: "hardhat" as "hardhat" | "ganache",
  async setBalance(rpc: ReturnType<typeof makeRpc>, account: Hex, wei: bigint) {
    const hex = `0x${wei.toString(16)}`;
    return devnet.kind === "hardhat" ? rpc("hardhat_setBalance", [account, hex]) : rpc("evm_setAccountBalance", [account, hex]);
  },
  async mine(rpc: ReturnType<typeof makeRpc>, blocks: number) {
    if (devnet.kind === "hardhat") return rpc("hardhat_mine", [`0x${blocks.toString(16)}`]);
    for (let i = 0; i < blocks; i++) await rpc("evm_mine", []);
  },
};
/** the local stack's placement block, when the node is its devnet (scripts/local-stack/run/stack.json) */
function devnetDeployedBlock(): number | null {
  if (process.env.CLASSIC_DEVNET_DEPLOYED_BLOCK) return Number(process.env.CLASSIC_DEVNET_DEPLOYED_BLOCK);
  const stackFile = join(__dirname, "..", "..", "..", "scripts", "local-stack", "run", "stack.json");
  if (!existsSync(stackFile)) return null;
  try {
    const stack = JSON.parse(readFileSync(stackFile, "utf8")) as { classic?: { deployedBlock?: number } };
    return typeof stack.classic?.deployedBlock === "number" ? stack.classic.deployedBlock : null;
  } catch {
    return null;
  }
}
const POOL = poolOf("eth-100");
const ROUTER = DEPLOYMENT.router.address as Hex;
const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const hexOf = (b: Uint8Array) => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}` as Hex;
const freshAddress = () => hexOf(randomBytes(20));

/** The fork's account as a browser wallet: every request to the node, transactions sent from the account. */
function forkProvider(rpc: ReturnType<typeof makeRpc>, account: Hex): Eip1193Provider {
  return {
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_sendTransaction") return rpc("eth_sendTransaction", [{ ...((params as [Record<string, unknown>])[0] ?? {}), from: account }]);
      return rpc(method, (params as unknown[]) ?? []);
    },
    on() {},
    removeListener() {},
  };
}

/** A relayer in this process, as tornado-relayer behaves: the status, each withdrawal sent through the router from its account, the job followed. */
function forkRelayer(rpc: ReturnType<typeof makeRpc>, account: Hex) {
  const jobs = new Map<string, { status: string; txHash: Hex | null; block: number | null; failedReason: string | null }>();
  const posted: unknown[] = [];
  const transport: RelayerTransport & { posted: unknown[] } = {
    posted,
    async getJson(url): Promise<RelayerAnswer> {
      if (url.endsWith("/v1/status")) {
        return {
          status: 200,
          body: {
            rewardAccount: account,
            instances: { eth: { instanceAddress: Object.fromEntries(POOLS.map((p) => [p.amount, p.address])), symbol: "ETH", decimals: 18 } },
            netId: 1,
            ethPrices: {},
            tornadoServiceFee: 0.3,
            miningServiceFee: 0,
            version: "4.1.4",
            health: { status: "true", error: "" },
            currentQueue: 0,
          },
        };
      }
      const id = url.split("/v1/jobs/")[1];
      const job = id ? jobs.get(id) : undefined;
      if (!job) return { status: 400, body: { error: "The job doesn't exist" } };
      if (job.status === "SENT" && job.txHash) {
        const receipt = (await rpc("eth_getTransactionReceipt", [job.txHash])) as { status: string; blockNumber: string } | null;
        if (receipt) {
          job.block = Number.parseInt(receipt.blockNumber, 16);
          if (receipt.status !== "0x1") {
            job.status = "FAILED";
            job.failedReason = "the transaction reverted";
          } else job.status = "MINED";
        }
      } else if (job.status === "MINED") job.status = "CONFIRMED";
      return {
        status: 200,
        body: {
          id,
          type: "TORNADO_WITHDRAW",
          status: job.status,
          txHash: job.txHash,
          confirmations: job.status === "CONFIRMED" ? 1 : 0,
          failedReason: job.failedReason,
        },
      };
    },
    async postJson(url, body): Promise<RelayerAnswer> {
      posted.push({ url, body });
      const parsed = WithdrawRequestSchema.safeParse(body);
      if (!parsed.success) return { status: 400, body: { error: "the request is not the protocol's" } };
      const { proof, contract, args } = parsed.data;
      if (args[3].toLowerCase() !== account) return { status: 400, body: { error: "This proof is for different relayer" } };
      const id = `fork-${jobs.size + 1}`;
      const job = { status: "QUEUED", txHash: null as Hex | null, block: null as number | null, failedReason: null as string | null };
      jobs.set(id, job);
      try {
        const data = encodeRouterWithdraw(contract as Hex, {
          proof: proof as Hex,
          root: args[0] as Hex,
          nullifierHash: args[1] as Hex,
          recipient: args[2] as Hex,
          relayer: args[3] as Hex,
          feeWei: BigInt(args[4]),
          refundWei: BigInt(args[5]),
        });
        job.txHash = (await rpc("eth_sendTransaction", [{ from: account, to: ROUTER, data, value: "0x0" }])) as Hex;
        job.status = "SENT";
      } catch (e) {
        job.status = "FAILED";
        job.failedReason = e instanceof Error ? e.message : String(e);
      }
      return { status: 200, body: { id } };
    },
  };
  return transport;
}

describe.skipIf(!ready)("Tornado Classic on a mainnet fork (CLASSIC_FORK_RPC)", () => {
  const rpc = makeRpc([FORK ?? "http://127.0.0.1:8547"], { timeoutMs: 300_000 });
  let prover: NodeProver;
  let services: ClassicServices;
  let relayer: ReturnType<typeof forkRelayer>;
  const forkBlockAtStart = { n: 0 };
  /** "fork": mainnet's state behind the node (the snapshot synced onto it); "devnet": the local stack's empty pools */
  let mode: "fork" | "devnet" = "fork";

  beforeAll(async () => {
    prover = await nodeProver(2);
    const client = String(await rpc("web3_clientVersion", []));
    devnet.kind = /ganache/i.test(client) ? "ganache" : "hardhat";
    ACCOUNTS.push(...((await rpc("eth_accounts", [])) as string[]).slice(0, 3).map((a) => a.toLowerCase() as Hex));
    if (ACCOUNTS.length < 3) throw new Error("the node has fewer than three unlocked accounts");
    for (const a of ACCOUNTS) await devnet.setBalance(rpc, a, 30_000n * 10n ** 18n);
    relayer = forkRelayer(rpc, ACCOUNTS[1]);
    // mainnet's state behind the node, or the local stack's empty pools
    const nextIndex = Number(BigInt((await rpc("eth_call", [{ to: POOL.address, data: "0xfc7e9c6f" }, "latest"])) as string));
    mode = nextIndex >= 49_628 ? "fork" : "devnet";
    const placedAt = mode === "devnet" ? devnetDeployedBlock() : null;
    if (mode === "fork" && !existsSync(join(SNAPSHOT, "manifest.json")))
      throw new Error(`a mainnet fork needs the snapshot under ${SNAPSHOT} (npm run snapshot -- --pool eth-100)`);
    if (mode === "devnet" && placedAt === null) throw new Error("the devnet mode needs scripts/local-stack/run/stack.json or CLASSIC_DEVNET_DEPLOYED_BLOCK");
    const snapshot =
      mode === "fork"
        ? {
            manifest: JSON.parse(readFileSync(join(SNAPSHOT, "manifest.json"), "utf8")) as SnapshotManifest,
            texts: Object.fromEntries(
              ["deposits.json", "withdrawals.json", "tree.json"].map((f) => [f, readFileSync(join(SNAPSHOT, f), "utf8")]),
            ) as unknown as SnapshotTexts,
          }
        : null;
    console.info(`FORK  ${client}: ${mode} mode (the 100 ETH pool at nextIndex ${nextIndex}), accounts ${ACCOUNTS.join(", ")}`);
    const wallet = new WalletSession({
      router: ROUTER,
      expectedChainId: 1,
      discover: async () => [{ info: { id: "fork", name: "Fork account #0" }, provider: forkProvider(rpc, ACCOUNTS[0]) }],
    });
    await wallet.discover();
    await wallet.connect("fork");
    services = createServices({
      config: configFromEnv({
        VITE_CLASSIC_RPC_URLS: FORK,
        VITE_CLASSIC_LIVE: JSON.stringify({ "eth-100": ["deposit", "withdraw"] }),
        ...(placedAt !== null ? { VITE_CLASSIC_DEPLOYED_BLOCK: String(placedAt) } : {}),
      }),
      rpc,
      prover: async () => prover,
      historyStore: memoryHistoryStore(),
      jobs: memoryJobsStore(),
      fetchSnapshot: async (pool) => (pool === "eth-100" && snapshot ? snapshot : null),
      relayerTransport: relayer,
      curated: [
        {
          ensName: "fork-relayer",
          relayerAddress: ACCOUNTS[1],
          url: "http://fork-relayer.invalid",
          rewardAccount: ACCOUNTS[1],
          stakeTorn: "0",
          feePercent: 0.3,
          version: "4.1.4",
          currentQueue: 0,
        },
      ],
      wallet,
      followOptions: { intervalMs: 500, maxMs: 300_000 },
      receiptOptions: { pollMs: 500, maxMs: 300_000 },
    });
    forkBlockAtStart.n = Number.parseInt((await rpc("eth_blockNumber", [])) as string, 16);
  });
  afterAll(async () => {
    await prover?.close();
  });

  const mine = (blocks: number) => devnet.mine(rpc, blocks);
  const balance = async (a: Hex) => BigInt((await rpc("eth_getBalance", [a, "latest"])) as string);
  /** the note found in the synced history after `blocks` more blocks */
  const found = async (note: ClassicNote): Promise<DepositFacts> => {
    await mine(12);
    const history = services.histories.get("eth-100")!;
    const status = await history.refresh();
    expect(status).toMatchObject({ kind: "ready", verified: true });
    const derived = await prover.note(formatNote(note));
    if (!derived.ok) throw new Error("the note is not readable");
    const facts = history.lookup(derived.commitment, derived.nullifierHash);
    if (!facts) throw new Error("the deposit is not in the synced history");
    return facts;
  };

  it("the node is mainnet or its image: chain id 1, the 100 ETH pool's code is the pinned one, the registry has it ENABLED, the history (the served snapshot on a fork, the placement block on the devnet) syncs onto it and the pool knows its root", async () => {
    expect(Number.parseInt((await rpc("eth_chainId", [])) as string, 16)).toBe(1);
    await services.checkPool("eth-100");
    expect(services.facts.get("eth-100")).toEqual({ contract: "verified", router: "enabled" });
    const status = await services.histories.get("eth-100")!.ensure();
    expect(status).toMatchObject({ kind: "ready", verified: true });
    if (status.kind !== "ready") return;
    if (mode === "fork") expect(status.leaves).toBeGreaterThanOrEqual(49_628);
    console.info(`FORK  ${mode} at block ${forkBlockAtStart.n}: the 100 ETH pool at ${status.leaves} leaves, synced to ${status.toBlock}, root ${status.root}`);
  });

  it("a 100 ETH deposit through the router, found in the history after 12 confirmations; the withdrawal proved in Node and sent through the router by the relayer stand-in — followed to CONFIRMED, the recipient paid, the note spent on chain", async () => {
    const note = generateNote("eth", "100", 1, randomBytes);
    const poolBefore = await balance(POOL.address);
    const deposit = await depositFlow(services, { pool: "eth-100", note });
    expect(deposit.state).toBe("COMPLETED");
    expect((await balance(POOL.address)) - poolBefore).toBe(100n * 10n ** 18n);
    const facts = await found(note);
    expect(facts.depositsSince).toBe(0);
    expect(facts.spent).toBe(false);

    await services.relayers.refresh();
    const entry = services.relayers.entry("fork-relayer");
    expect(entry?.status).toBe("online");
    const gasPrice = BigInt((await rpc("eth_gasPrice", [])) as string);
    const fees = feeLines(POOL, { feePercentE4: 3_000 }, gasPrice);
    const recipient = freshAddress();
    const steps: string[] = [];
    const job = await withdrawalFlow(services, {
      pool: "eth-100",
      note,
      facts,
      recipient,
      via: "relayer",
      relayerId: "fork-relayer",
      feeWei: fees.totalFeeWei,
      confirm: async () => true,
      onStep: (s) => steps.push(s.step === "following" ? `following:${s.relayerState}` : s.step),
    });
    expect(job.state, job.failedReason ?? "").toBe("COMPLETED");
    expect(job.relayerState).toBe("CONFIRMED");
    expect(steps).toContain("following:CONFIRMED");
    expect(await balance(recipient)).toBe(100n * 10n ** 18n - fees.totalFeeWei);
    const derived = await prover.note(formatNote(note));
    if (!derived.ok) throw new Error("unreadable");
    expect(await isSpentOnChain(rpc, POOL.address, derived.nullifierHash)).toBe(true);
    // the pool's own Withdrawal event, in the relayer's transaction
    const receipt = (await rpc("eth_getTransactionReceipt", [job.txHash])) as { blockNumber: string; logs: RawLog[] };
    const { withdrawals } = decodeLogs(
      receipt.logs.filter((l) => l.address.toLowerCase() === POOL.address.toLowerCase()),
      POOL.address,
    );
    expect(withdrawals.length).toBe(1);
    expect(withdrawals[0].nullifierHash.toLowerCase()).toBe(derived.nullifierHash.toLowerCase());
    expect(withdrawals[0].to.toLowerCase()).toBe(recipient.toLowerCase());
    console.info(`FORK  withdrawal ${job.txHash}: ${prover.proofs.length} proof(s) so far, fee ${fees.totalFeeWei} wei`);
  });

  it("the root ages out of the pool's hundred between the proof and the confirmation (a hundred deposits meanwhile): synced again, proved again once, withdrawn in wallet mode", async () => {
    const note = generateNote("eth", "100", 1, randomBytes);
    expect((await depositFlow(services, { pool: "eth-100", note })).state).toBe("COMPLETED");
    const facts = await found(note);
    const proofsBefore = prover.proofs.length;
    const recipient = freshAddress();
    const job = await withdrawalFlow(services, {
      pool: "eth-100",
      note,
      facts,
      recipient,
      via: "wallet",
      confirm: async () => {
        // a hundred deposits straight to the pool from account #2 while the confirmation is open: the window of a hundred roots moves past ours
        for (let i = 0; i < 100; i++) {
          await rpc("eth_sendTransaction", [
            {
              from: ACCOUNTS[2],
              to: POOL.address,
              data: encodePoolDeposit(("0x00" + hexOf(randomBytes(31)).slice(2)) as Hex),
              value: `0x${(100n * 10n ** 18n).toString(16)}`,
            },
          ]);
        }
        await mine(12);
        return true;
      },
    });
    expect(job.state, job.failedReason ?? "").toBe("COMPLETED");
    expect(job.via).toBe("wallet");
    expect(prover.proofs.length).toBe(proofsBefore + 2);
    expect(BigInt(prover.proofs[proofsBefore + 1].root)).not.toBe(BigInt(prover.proofs[proofsBefore].root));
    expect(await balance(recipient)).toBe(100n * 10n ** 18n);
    const history = services.histories.get("eth-100")!;
    expect(history.state!.leaves).toBeGreaterThanOrEqual(facts.leafIndex + 101);
    console.info(`FORK  the aged root re-proved: ${history.state!.leaves} leaves now; ${prover.proofs.length} proofs in all`);
  });
});
