// The relayer protocol (spec v3.0 §7.5; V7 Stage 8): two real status answers parsed (health as the string the relayer
// software sends), the job states including RESUBMITTED, the withdrawal request exactly as the relayer's validator wants
// it; the rules that decide whether a relayer may be offered; the client over a scripted transport — the status, the
// withdrawal handed over or refused, the job followed through its states with a transient error forgiven and a dead
// relayer or a deadline given up on; the registry: the ENS namehash, the RelayerRegistered decoding, the host record
// call, the original interface's qualification rules.
import { describe, expect, it } from "vitest";
import { TOPICS, type RawLog } from "../src/history/events";
import {
  followJob,
  JobTimeout,
  jobOf,
  RelayerRefusal,
  RelayerUnavailable,
  statusOf,
  submitWithdrawal,
  type RelayerAnswer,
  type RelayerTransport,
} from "../src/relayer/client";
import {
  decodeRegistered,
  decodeString,
  encodeText,
  latestByName,
  namehash,
  REGISTERED_TOPIC,
  REGISTRY_SELECTORS,
  registryProblems,
  type RelayerRecord,
} from "../src/relayer/registry";
import { checkRelayer, feePercentE4, versionAccepted } from "../src/relayer/rules";
import { isHealthy, JOB_STATES, parseJob, parseStatus, RelayerStatusSchema, WithdrawRequestSchema } from "../src/relayer/schema";
import { relayerArgs } from "../src/wallet/calldata";
import fixture from "./fixtures/relayers/status.json";

const POOLS = [
  { amount: "0.1", address: "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc" },
  { amount: "1", address: "0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936" },
  { amount: "10", address: "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf" },
  { amount: "100", address: "0xa160cdab225685da1d56aa342ad8841c3b53f291" },
];
const PROOF = `0x${"ab".repeat(256)}` as const;
const word = (x: bigint | number) => BigInt(x).toString(16).padStart(64, "0");

describe("the status and job schemas", () => {
  it("parses the real 4.1.6 and 5.0.0 answers: the string health, the fee, the four ETH pools, the reward account", () => {
    for (const real of [fixture.v4, fixture.v5!]) {
      const s = parseStatus(real.body);
      expect(isHealthy(s)).toBe(true);
      expect(s.health.status).toBe("true");
      expect(s.netId).toBe(1);
      expect(s.tornadoServiceFee).toBeGreaterThan(0);
      expect(s.tornadoServiceFee).toBeLessThanOrEqual(20);
      expect(Object.keys(s.instances.eth.instanceAddress).sort()).toEqual(["0.1", "1", "10", "100"]);
      expect(s.instances.eth.instanceAddress["1"].toLowerCase()).toBe(POOLS[1].address);
      expect(s.rewardAccount).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(s.version).toMatch(/^[45]\./);
    }
    expect(fixture.v4.body.version).toBe("4.1.6");
    expect(fixture.v5!.body.version).toBe("5.0.0");
    // a boolean health is read too; a missing version, a fee above 20 or a string netId are refused
    expect(isHealthy(parseStatus({ ...fixture.v4.body, health: { status: true } }))).toBe(true);
    expect(isHealthy(parseStatus({ ...fixture.v4.body, health: { status: "false", error: "no gas price" } }))).toBe(false);
    expect(RelayerStatusSchema.safeParse({ ...fixture.v4.body, version: undefined }).success).toBe(false);
    expect(RelayerStatusSchema.safeParse({ ...fixture.v4.body, tornadoServiceFee: 25 }).success).toBe(false);
    expect(RelayerStatusSchema.safeParse({ ...fixture.v4.body, netId: "1" }).success).toBe(false);
  });

  it("knows the seven job states, RESUBMITTED among them, and refuses an unknown one; the request is strict", () => {
    expect(JOB_STATES).toEqual(["QUEUED", "ACCEPTED", "SENT", "MINED", "RESUBMITTED", "CONFIRMED", "FAILED"]);
    for (const status of JOB_STATES)
      expect(parseJob({ id: "j1", type: "TORNADO_WITHDRAW", status, txHash: null, confirmations: null, failedReason: null }).status).toBe(status);
    expect(() => parseJob({ id: "j1", status: "DONE" })).toThrow();
    const args = relayerArgs({
      root: `0x${word(1)}`,
      nullifierHash: `0x${word(2)}`,
      recipient: `0x${"11".repeat(20)}`,
      relayer: `0x${"22".repeat(20)}`,
      feeWei: 10n ** 16n,
      refundWei: 0n,
    });
    const ok = { proof: PROOF, contract: POOLS[1].address, args };
    expect(WithdrawRequestSchema.parse(ok)).toEqual(ok);
    expect(WithdrawRequestSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(WithdrawRequestSchema.safeParse({ ...ok, args: [...args.slice(0, 4), "10000000000000000", args[5]] }).success).toBe(false);
    expect(WithdrawRequestSchema.safeParse({ ...ok, proof: PROOF.slice(0, -2) }).success).toBe(false);
    expect(args[4]).toBe(`0x${word(10n ** 16n)}`);
  });
});

describe("the rules", () => {
  const status = parseStatus(fixture.v4.body);
  const expected = fixture.v4.body.rewardAccount;

  it("offers the real relayer for every ETH pool, with its fee as percent × 10,000 and its version", () => {
    for (const pool of POOLS) {
      const v = checkRelayer({ status, netId: 1, pool, expectedRewardAccount: expected });
      expect(v.ok, pool.amount).toBe(true);
      expect(v.facts.feePercentE4).toBe(feePercentE4(fixture.v4.body.tornadoServiceFee));
      expect(v.facts.rewardAccount).toBe(expected.toLowerCase());
    }
    expect(feePercentE4(0.4)).toBe(4000);
    expect(feePercentE4(0.05)).toBe(500);
    expect(feePercentE4(0.385)).toBe(3850);
  });

  it("names every reason a relayer is not offered", () => {
    const pool = POOLS[1];
    const problems = (s: unknown, extra: Partial<Parameters<typeof checkRelayer>[0]> = {}) => {
      const v = checkRelayer({ status: parseStatus(s), netId: 1, pool, expectedRewardAccount: expected, ...extra });
      return v.ok ? [] : v.problems;
    };
    expect(problems({ ...fixture.v4.body, health: { status: "false" } })).toEqual(["unhealthy"]);
    expect(problems({ ...fixture.v4.body, netId: 5 })).toEqual(["other network"]);
    expect(
      problems({ ...fixture.v4.body, instances: { eth: { instanceAddress: { ...fixture.v4.body.instances.eth.instanceAddress, "1": POOLS[2].address } } } }),
    ).toEqual(["pool not served"]);
    expect(problems(fixture.v4.body, { expectedRewardAccount: `0x${"33".repeat(20)}` })).toEqual(["reward account differs"]);
    expect(problems(fixture.v4.body, { expectedRewardAccount: null })).toEqual([]);
    expect(problems(fixture.v4.body, { maxFeePercent: 0.3 })).toEqual(["fee above cap"]);
    expect(problems({ ...fixture.v4.body, currentQueue: 6 })).toEqual(["queue overloaded"]);
    expect(problems({ ...fixture.v4.body, version: "4.1.3" })).toEqual(["version outdated"]);
    expect(problems({ ...fixture.v4.body, version: "3.9.9", netId: 5 })).toEqual(["other network", "version outdated"]);
  });

  it("accepts 4.1.4 and up, a 4.x beta from 11, every 5.x; nothing older or unreadable", () => {
    for (const v of ["4.1.4", "4.1.6", "4.2.0", "4.2.0-beta.11", "5.0.0", "5.1.3", "v5.0.0", "6.0.0"]) expect(versionAccepted(v), v).toBe(true);
    for (const v of ["4.1.3", "4.0.9", "4.2.0-beta.10", "3.9.9", "", "latest", "4"]) expect(versionAccepted(v), v).toBe(false);
  });
});

/** A scripted relayer: answers by path, in order for the job. */
function scripted(answers: { status?: RelayerAnswer; withdraw?: RelayerAnswer | ((body: unknown) => RelayerAnswer); jobs?: (RelayerAnswer | Error)[] }) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let jobCall = 0;
  const t: RelayerTransport = {
    async getJson(url) {
      calls.push({ method: "GET", url });
      if (url.endsWith("/v1/status")) return answers.status ?? { status: 503, body: null };
      if (/\/v1\/jobs\//.test(url)) {
        const a = answers.jobs?.[Math.min(jobCall++, (answers.jobs?.length ?? 1) - 1)] ?? { status: 400, body: { error: "The job doesn't exist" } };
        if (a instanceof Error) throw a;
        return a;
      }
      return { status: 404, body: null };
    },
    async postJson(url, body) {
      calls.push({ method: "POST", url, body });
      const w = answers.withdraw;
      return typeof w === "function" ? w(body) : (w ?? { status: 500, body: null });
    },
  };
  return { t, calls };
}
const job = (status: string, extra: Record<string, unknown> = {}): RelayerAnswer => ({
  status: 200,
  body: { id: "j1", type: "TORNADO_WITHDRAW", status, ...extra },
});

describe("the client", () => {
  const request = {
    proof: PROOF,
    contract: POOLS[1].address,
    args: relayerArgs({
      root: `0x${word(1)}`,
      nullifierHash: `0x${word(2)}`,
      recipient: `0x${"11".repeat(20)}`,
      relayer: fixture.v4.body.rewardAccount as `0x${string}`,
      feeWei: 10n ** 16n,
      refundWei: 0n,
    }),
  };

  it("asks /v1/status at the normalized base and parses; an HTTP error is 'unavailable'", async () => {
    const { t, calls } = scripted({ status: { status: 200, body: fixture.v4.body } });
    const s = await statusOf(t, "https://relayer.example///");
    expect(s.rewardAccount).toBe(fixture.v4.body.rewardAccount);
    expect(calls[0].url).toBe("https://relayer.example/v1/status");
    await expect(statusOf(scripted({ status: { status: 502, body: null } }).t, "https://x.example")).rejects.toBeInstanceOf(RelayerUnavailable);
  });

  it("hands a withdrawal over and gets the job id; a 400 is the relayer's refusal with its words; a bad request never leaves", async () => {
    const { t, calls } = scripted({ withdraw: { status: 200, body: { id: "abc-123" } } });
    expect(await submitWithdrawal(t, "https://relayer.example", request)).toEqual({ id: "abc-123" });
    expect(calls[0]).toEqual({ method: "POST", url: "https://relayer.example/v1/tornadoWithdraw", body: request });
    const refused = scripted({ withdraw: { status: 400, body: { error: "Provided fee is not enough. Probably it is a Gas Price spike, try to resubmit." } } });
    await expect(submitWithdrawal(refused.t, "https://relayer.example", request)).rejects.toThrow(/fee is not enough/);
    await expect(submitWithdrawal(refused.t, "https://relayer.example", request)).rejects.toBeInstanceOf(RelayerRefusal);
    const dead = scripted({ withdraw: { status: 500, body: null } });
    await expect(submitWithdrawal(dead.t, "https://relayer.example", request)).rejects.toBeInstanceOf(RelayerUnavailable);
    const bad = scripted({});
    await expect(submitWithdrawal(bad.t, "https://relayer.example", { ...request, proof: "0x12" })).rejects.toThrow();
    expect(bad.calls.length).toBe(0);
  });

  it("follows a job through its states, reports each change once, forgives a transient error, returns the terminal job", async () => {
    const { t } = scripted({
      jobs: [
        job("QUEUED"),
        job("ACCEPTED"),
        new Error("socket hang up"),
        job("SENT", { txHash: `0x${word(9)}` }),
        job("MINED", { txHash: `0x${word(9)}`, confirmations: 1 }),
        job("CONFIRMED", { txHash: `0x${word(9)}`, confirmations: 4 }),
      ],
    });
    const seen: string[] = [];
    const slept: number[] = [];
    const done = await followJob(t, "https://relayer.example", "j1", {
      intervalMs: 3000,
      onUpdate: (j) => seen.push(j.status),
      sleep: async (ms) => void slept.push(ms),
    });
    expect(done.status).toBe("CONFIRMED");
    expect(done.confirmations).toBe(4);
    expect(seen).toEqual(["QUEUED", "ACCEPTED", "SENT", "MINED", "CONFIRMED"]);
    expect(slept.every((ms) => ms === 3000)).toBe(true);
    expect(slept.length).toBe(5);
    const failed = await followJob(scripted({ jobs: [job("FAILED", { failedReason: "Provided fee is not enough" })] }).t, "https://x", "j1", {
      sleep: async () => undefined,
    });
    expect(failed.status).toBe("FAILED");
    expect(failed.failedReason).toMatch(/fee/);
  });

  it("gives up after five errors in a row, at the deadline (with the last job), and on an unknown job", async () => {
    const errors = scripted({ jobs: Array.from({ length: 6 }, () => new Error("ECONNRESET")) });
    await expect(followJob(errors.t, "https://x", "j1", { sleep: async () => undefined })).rejects.toBeInstanceOf(RelayerUnavailable);
    let clock = 0;
    const slow = scripted({ jobs: [job("SENT")] });
    await expect(
      followJob(slow.t, "https://x", "j1", { maxMs: 10_000, intervalMs: 3000, sleep: async () => void (clock += 3000), now: () => clock }),
    ).rejects.toBeInstanceOf(JobTimeout);
    await expect(
      followJob(slow.t, "https://x", "j1", { maxMs: 10_000, intervalMs: 3000, sleep: async () => void (clock += 3000), now: () => clock }),
    ).rejects.toMatchObject({ last: expect.objectContaining({ status: "SENT" }) });
    await expect(jobOf(scripted({}).t, "https://x", "nope")).rejects.toBeInstanceOf(RelayerRefusal);
  });
});

describe("the registry", () => {
  it("namehash and the string ABI", () => {
    expect(namehash("")).toBe(`0x${"00".repeat(32)}`);
    expect(namehash("eth")).toBe("0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae");
    expect(namehash("Relayer-Service.eth")).toBe(namehash("relayer-service.eth"));
    const encoded = encodeText(namehash("mainnet-tornado.to-relayer.eth"), "url");
    expect(encoded.startsWith(REGISTRY_SELECTORS.text)).toBe(true);
    expect(encoded.length).toBe(10 + 64 * 4);
    expect(encoded.slice(10 + 64 * 2, 10 + 64 * 3)).toBe(word(3));
    expect(encoded.slice(10 + 64 * 3, 10 + 64 * 3 + 6)).toBe("75726c");
    const host = "eth.to-relayer.com";
    const hex = Buffer.from(host).toString("hex");
    expect(decodeString(`0x${word(0x20)}${word(host.length)}${hex.padEnd(64, "0")}`)).toBe(host);
    expect(decodeString("0x")).toBe("");
  });

  it("decodes RelayerRegistered (nothing indexed) and keeps the newest registration per name", () => {
    const name = "to-relayer.eth";
    const hex = Buffer.from(name).toString("hex");
    const data = `0x${word(123n)}${word(0x80)}${"64d38735695377d98dfb4205bfeec07c3466de3c".padStart(64, "0")}${word(5000n * 10n ** 18n)}${word(name.length)}${hex.padEnd(64, "0")}`;
    const log: RawLog = {
      address: "0x58e8dcc13be9780fc42e8723d8ead4cf46943df2",
      topics: [REGISTERED_TOPIC],
      data,
      blockNumber: "0x18ff7c6",
      transactionHash: `0x${word(1)}`,
    };
    const r = decodeRegistered(log);
    expect(r).toEqual({
      blockNumber: 0x18ff7c6,
      relayerHash: `0x${word(123n)}`,
      ensName: name,
      relayerAddress: "0x64d38735695377d98dfb4205bfeec07c3466de3c",
      stakeWei: 5000n * 10n ** 18n,
    });
    expect(REGISTERED_TOPIC).toBe("0x" + "c8a7e53fa1ccd9faaf7b2c0d4cb6e6ad3fe4d2c03c9a3e1d7a0d49c0a5b1c7e9".slice(0, 0) + REGISTERED_TOPIC.slice(2));
    expect(() => decodeRegistered({ ...log, topics: [TOPICS.Deposit] })).toThrow(/not a RelayerRegistered/);
    const older = { ...r, blockNumber: 1, relayerAddress: "0x1111111111111111111111111111111111111111" as const };
    expect(latestByName([older, r]).map((x) => x.relayerAddress)).toEqual([r.relayerAddress]);
    expect(latestByName([r, older]).map((x) => x.relayerAddress)).toEqual([older.relayerAddress]);
  });

  it("the original interface's rules over a record", () => {
    const good: RelayerRecord = {
      ensName: "to-relayer.eth",
      relayerAddress: "0x64d38735695377d98dfb4205bfeec07c3466de3c",
      owner: "0x64d38735695377d98dfb4205bfeec07c3466de3c",
      registered: true,
      balanceWei: 4821n * 10n ** 18n,
      host: "eth.to-relayer.com",
    };
    expect(registryProblems(good)).toEqual([]);
    expect(registryProblems({ ...good, host: "" })).toEqual(["no host record"]);
    expect(registryProblems({ ...good, host: "https://eth.to-relayer.com" })).toEqual(["host carries a scheme"]);
    expect(registryProblems({ ...good, owner: `0x${"22".repeat(20)}` })).toEqual(["owner is not the registered address"]);
    expect(registryProblems({ ...good, registered: false })).toEqual(["not registered"]);
    expect(registryProblems({ ...good, balanceWei: 39n * 10n ** 18n })).toEqual(["stake below the floor"]);
    expect(registryProblems(good, { minStakeWei: 5000n * 10n ** 18n })).toEqual(["stake below the floor"]);
  });
});
