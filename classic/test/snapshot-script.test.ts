// The snapshot generator's pieces (V7 Stage 7): the ZIP reader on an archive built here (stored and deflated entries),
// and — when the original UI's clone sits beside the repository — its seed for the 100 ETH pool: 27,544 deposits in
// leaf order to block 14,954,101, the withdrawals in block order, the tree's root the one the chain's archive answered
// (vectors/roots.json).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MerkleTree } from "../src/crypto/tree";
import type { DepositEvent, WithdrawalEvent } from "../src/history/events";
import { CLASSIC_UI_EVENTS, seedFromClassicUi } from "../scripts/snapshot.mjs";
import { readZip } from "../scripts/zip.mjs";
import roots from "../vectors/roots.json";

/** A ZIP archive with the given entries (method 0 stored or 8 deflated), as the classic-ui caches are. */
function zipOf(entries: { name: string; data: Buffer; deflate: boolean }[]): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = e.deflate ? deflateRawSync(e.data) : e.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc(e.data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc(e.data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, eocd]);
}

describe("the ZIP reader", () => {
  it("reads stored and deflated entries by name, and refuses what is not an archive", () => {
    const a = Buffer.from(JSON.stringify([{ leafIndex: 0, commitment: "0x01" }]));
    const b = Buffer.from("x".repeat(10_000));
    const files = readZip(
      zipOf([
        { name: "deposits_eth_100.json", data: a, deflate: true },
        { name: "plain.txt", data: b, deflate: false },
      ]),
    );
    expect([...files.keys()]).toEqual(["deposits_eth_100.json", "plain.txt"]);
    expect(files.get("deposits_eth_100.json")!.equals(a)).toBe(true);
    expect(files.get("plain.txt")!.equals(b)).toBe(true);
    expect(() => readZip(Buffer.from("not a zip at all, not even close to twenty-two bytes?"))).toThrow(/not a ZIP/);
  });
});

interface Seed {
  deposits: DepositEvent[];
  withdrawals: WithdrawalEvent[];
  toBlock: number;
  source: string;
}
const haveClone = existsSync(CLASSIC_UI_EVENTS);
describe.skipIf(!haveClone)("the original UI's cache as a seed (the classic-ui clone beside the repository)", () => {
  it("the 100 ETH pool: 27,544 deposits in leaf order to block 14,954,101, the withdrawals in block order, the first 1,024 leaves the fixture's (whose root the chain's archive answered)", () => {
    const seed = seedFromClassicUi("100") as Seed | null;
    expect(seed).not.toBeNull();
    expect(seed!.deposits.length).toBe(27544);
    expect(seed!.toBlock).toBe(14954101);
    expect(seed!.deposits[0].leafIndex).toBe(0);
    expect(seed!.deposits.at(-1)!.leafIndex).toBe(27543);
    expect(seed!.deposits.at(-1)!.commitment).toBe(roots["eth-100"].lastCommitment);
    expect(seed!.withdrawals.every((w, i, a) => i === 0 || a[i - 1].blockNumber <= w.blockNumber)).toBe(true);
    expect(seed!.withdrawals.every((w) => w.blockNumber <= 14954101 && w.relayer === null)).toBe(true);
    // the full root (27,544 leaves, 27 s of hashing) is held in the live suite and vectors/roots.json; here the fixture's cut
    const first = MerkleTree.fromLeaves(seed!.deposits.slice(0, 1024).map((d) => BigInt(d.commitment)));
    const manifest = JSON.parse(readFileSync(join(__dirname, "fixtures", "history", "first-1024", "eth-100", "manifest.json"), "utf8")) as {
      root: string;
      toBlock: number;
    };
    expect(`0x${first.root.toString(16).padStart(64, "0")}`).toBe(manifest.root);
    expect(seed!.deposits[1023].blockNumber).toBe(manifest.toBlock);
  }, 60_000);
});
