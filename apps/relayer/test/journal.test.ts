// The relayer's file journals (a V6 follow-up of 2026-10-15): what is saved is loaded, through a temporary file flushed to
// the disk and renamed; a journal that cannot be read stops the relayer at start, naming the file, and is left as it is.
// Before, a damaged journal loaded as no jobs at all and the next save overwrote it: every funded escrow's execution and
// refund, every shield and every fee-note opening in it was forgotten without a word.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utf8ToBytes } from "@noble/hashes/utils";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex, PublicClient, WalletClient } from "viem";
import { FileJournal, JournalUnreadable } from "../src/journal";
import { Relayer } from "../src/relayer";
import { ShieldExecutor } from "../src/shieldExecutor";
import { SwapExecutor } from "../src/swapExecutor";

const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "relayer-journal-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the relayer's file journals", () => {
  it("a missing file holds no jobs; what is saved is loaded again, and no temporary file is left", () => {
    const d = dir();
    const path = join(d, "swap-jobs.json");
    expect(new FileJournal(path).load()).toEqual([]);
    new FileJournal<{ id: string }>(path).save([{ id: "a" }, { id: "b" }]);
    expect(new FileJournal<{ id: string }>(path).load()).toEqual([{ id: "a" }, { id: "b" }]);
    expect(readdirSync(d)).toEqual(["swap-jobs.json"]);
  });

  it("a damaged journal is refused by name and left as it is; it was read as no jobs and overwritten", () => {
    const path = join(dir(), "swap-jobs.json");
    for (const damaged of ['[{"id":"0x01","state":"waiting-fun', "", '{"id":"0x01"}']) {
      writeFileSync(path, damaged);
      const journal = new FileJournal(path);
      expect(() => journal.load()).toThrow(JournalUnreadable);
      expect(() => journal.load()).toThrow(/swap-jobs\.json is not a readable journal .*move it aside to start without its jobs/);
      expect(readFileSync(path, "utf8"), "left as it is").toBe(damaged);
    }
  });

  it("the relayer does not start over one: the submissions, the swap and the shield executor each meet it in their constructor", () => {
    const d = dir();
    const damaged = (name: string) => {
      writeFileSync(join(d, name), '[{"txHash":');
      return new FileJournal<never>(join(d, name));
    };
    const account = privateKeyToAccount(`0x${"7e".repeat(32)}` as Hex);
    const clients = { publicClient: {} as PublicClient, walletClient: {} as WalletClient };
    const core = "0x00000000000000000000000000000000000000c0" as const;
    expect(
      () =>
        new Relayer(
          {
            chainId: 1,
            core,
            feeVault: core,
            minFeeWei: 0n,
            gasEstimate: 1n,
            feeMarginBps: 0,
            privateKey: `0x${"7e".repeat(32)}`,
            masterSeed: utf8ToBytes("relayer-journal-test"),
            rpcUrl: "http://unused.test",
            requireReadableFeePayload: false,
            journal: damaged("submissions.json"),
          },
          clients,
        ),
    ).toThrow(/submissions\.json is not a readable journal/);
    expect(() => new SwapExecutor({ chainId: 1, escrowCreationCode: "0x", account, ...clients, journal: damaged("swap-jobs.json") })).toThrow(
      /swap-jobs\.json is not a readable journal/,
    );
    expect(() => new ShieldExecutor({ factory: core, account, ...clients, journal: damaged("shield-jobs.json") })).toThrow(
      /shield-jobs\.json is not a readable journal/,
    );
  });
});

describe("what every entry must look like (the fourth review round, 2026-11-03)", () => {
  it("an entry the validator refuses stops the load, by its index; a list of valid entries loads; the default asks only for records", () => {
    const path = join(dir(), "swap-jobs.json");
    const valid = (x: unknown) => typeof (x as { id?: unknown }).id === "string";
    writeFileSync(path, JSON.stringify([{ id: "a" }, { nope: 1 }]));
    expect(() => new FileJournal(path, valid).load()).toThrow(JournalUnreadable);
    expect(() => new FileJournal(path, valid).load()).toThrow(/entry 1 is not a job of this journal/);
    expect(() => new FileJournal(path).load()).not.toThrow();
    writeFileSync(path, JSON.stringify([{ id: "a" }, { id: "b" }]));
    expect(new FileJournal(path, valid).load()).toEqual([{ id: "a" }, { id: "b" }]);
    writeFileSync(path, JSON.stringify([{ id: "a" }, 7]));
    expect(() => new FileJournal(path).load()).toThrow(/entry 1 is not a job of this journal/);
  });
  it("the server hands each of its three journals a validator", () => {
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const calls = server.match(/new FileJournal\(join\(.*?\.json"\), \(x\) =>/g) ?? [];
    expect(calls).toHaveLength(3);
    expect(server.match(/new FileJournal\(/g)).toHaveLength(3);
  });
});
