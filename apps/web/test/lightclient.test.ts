// The light client's logic, offline and deterministic (the live suite runs it against mainnet and
// Sepolia): a synthetic chain whose sync committees are known BLS keys, whose beacon states are sparse
// SSZ trees holding exactly the leaves the proofs need, and whose updates are really signed. Covers the
// bootstrap, learning the next committee, rotating into the next period, and every refusal: a checkpoint
// that is not the bootstrap, too few signers, the wrong committee's signature, a bent finality or
// committee branch, a period skipped, a next committee that contradicts the proven one. Plus the
// Merkle-Patricia walker on hand-built tries and the header hash check.
import { describe, it, expect } from "vitest";
import { bls12_381 } from "@noble/curves/bls12-381";
import { bytesToHex, hexToBytes, keccak256, toRlp, type Hex } from "viem";
import { LightClient, LightClientError } from "@privacy-wallet/sdk/lightclient/beacon";
import type { LightClientBootstrap, LightClientHeader, LightClientUpdate } from "@privacy-wallet/sdk/lightclient/beacon";
import { beaconBlockHeaderRoot, computeDomain, executionPayloadHeaderDenebRoot, hashPair, merkleize, signingRoot, syncCommitteeRoot, uintChunk, type SyncCommittee } from "@privacy-wallet/sdk/lightclient/ssz";
import { BLS_DST, DOMAIN_SYNC_COMMITTEE, type BeaconChainSpec } from "@privacy-wallet/sdk/lightclient/spec";
import { mptGet, ProofError, verifyHeader, verifyStorage } from "@privacy-wallet/sdk/lightclient/execution";
import { syncLightClient } from "@privacy-wallet/sdk/lightclient";

const PERIOD_SLOTS = 8192;
const spec: BeaconChainSpec = {
  name: "test", chainId: 999n, genesisTime: Math.floor(Date.now() / 1000) - 12 * 10 * PERIOD_SLOTS, genesisValidatorsRoot: ("0x" + "11".repeat(32)) as Hex,
  forks: [{ name: "phase0", version: "0x00000001", epoch: 0 }, { name: "electra", version: "0x05000001", epoch: 0 }], beaconApis: [],
};
const P = 5; // the bootstrap's period

// ---- sparse SSZ trees: fixed nodes at generalized indices, zeros elsewhere ----
const ZERO = new Uint8Array(32);
function treeRoot(fixed: Map<number, Uint8Array>, g = 1): Uint8Array {
  if (fixed.has(g)) return fixed.get(g)!;
  const below = [...fixed.keys()].some((k) => { let x = k; while (x > g) x >>= 1; return x === g; });
  if (!below) return zeroAt(depthBelow(fixed, g));
  return hashPair(treeRoot(fixed, 2 * g), treeRoot(fixed, 2 * g + 1));
}
const maxDepth = (fixed: Map<number, Uint8Array>) => Math.max(...[...fixed.keys()].map((k) => 31 - Math.clz32(k)));
function depthBelow(fixed: Map<number, Uint8Array>, g: number) { return maxDepth(fixed) - (31 - Math.clz32(g)); }
const zeroCache: Uint8Array[] = [ZERO];
function zeroAt(d: number): Uint8Array { while (zeroCache.length <= d) zeroCache.push(hashPair(zeroCache[zeroCache.length - 1], zeroCache[zeroCache.length - 1])); return zeroCache[Math.max(d, 0)]; }
function branch(fixed: Map<number, Uint8Array>, g: number): Hex[] {
  const out: Hex[] = [];
  for (let x = g; x > 1; x >>= 1) out.push(bytesToHex(treeRoot(fixed, x ^ 1)));
  return out;
}

// ---- committees of known keys (one key per committee, 512 seats: enough for the protocol logic) ----
interface Keys { sk: bigint; committee: SyncCommittee }
function keys(seed: number): Keys {
  const sk = BigInt(1000 + seed);
  const pk = bytesToHex(bls12_381.getPublicKey(sk.toString(16).padStart(64, "0")));
  return { sk, committee: { pubkeys: Array(512).fill(pk), aggregate_pubkey: pk } };
}
const A = keys(1), B = keys(2), C = keys(3), WRONG = keys(9);

function execHeader(n: number) {
  return { parent_hash: ("0x" + "01".repeat(32)) as Hex, fee_recipient: ("0x" + "02".repeat(20)) as Hex, state_root: ("0x" + n.toString(16).padStart(64, "0")) as Hex, receipts_root: ("0x" + "03".repeat(32)) as Hex,
    logs_bloom: ("0x" + "00".repeat(256)) as Hex, prev_randao: ("0x" + "04".repeat(32)) as Hex, block_number: String(n), gas_limit: "30000000", gas_used: "21000", timestamp: "1700000000",
    extra_data: "0x6e696365" as Hex, base_fee_per_gas: "7", block_hash: ("0x" + (n + 1).toString(16).padStart(64, "0")) as Hex, transactions_root: ("0x" + "05".repeat(32)) as Hex,
    withdrawals_root: ("0x" + "06".repeat(32)) as Hex, blob_gas_used: "0", excess_blob_gas: "0" };
}
/** A light-client header at `slot` whose state holds `stateLeaves` and whose body proves an execution header. */
function header(slot: number, stateLeaves: Map<number, Uint8Array>): LightClientHeader {
  const execution = execHeader(slot);
  const body = new Map([[25, executionPayloadHeaderDenebRoot(execution)], [24, hexToBytes(("0x" + "77".repeat(32)) as Hex)]]);
  const stateRoot = bytesToHex(treeRoot(stateLeaves.size ? stateLeaves : new Map([[2, ZERO]])));
  return { beacon: { slot: String(slot), proposer_index: "7", parent_root: ("0x" + "aa".repeat(32)) as Hex, state_root: stateRoot, body_root: bytesToHex(treeRoot(body)) }, execution, execution_branch: branch(body, 25) };
}
const rootOf = (h: LightClientHeader) => bytesToHex(beaconBlockHeaderRoot(h.beacon));

function bootstrap(slot: number, current: Keys): { root: Hex; data: LightClientBootstrap } {
  const leaves = new Map([[86, syncCommitteeRoot(current.committee)], [87, ZERO]]);
  const h = header(slot, leaves);
  return { root: rootOf(h), data: { header: h, current_sync_committee: current.committee, current_sync_committee_branch: branch(leaves, 86) } };
}

/** An update attested at `attSlot`, finalizing `finSlot`, signed at attSlot+1 by `signer` with `n` participants; optionally carrying `next`. */
function update(o: { attSlot: number; finSlot: number; signer: Keys; n?: number; next?: Keys }): LightClientUpdate {
  const fin = header(o.finSlot, new Map());
  const leaves = new Map<number, Uint8Array>([[169, beaconBlockHeaderRoot(fin.beacon)], [87, o.next ? syncCommitteeRoot(o.next.committee) : ZERO]]);
  const att = header(o.attSlot, leaves);
  const sigSlot = o.attSlot + 1;
  const domain = computeDomain(DOMAIN_SYNC_COMMITTEE, spec.forks[1].version, spec.genesisValidatorsRoot);
  const msg = signingRoot(beaconBlockHeaderRoot(att.beacon), domain);
  const n = o.n ?? 512;
  const one = bls12_381.G2.ProjectivePoint.fromHex(bytesToHex(bls12_381.sign(msg, o.signer.sk.toString(16).padStart(64, "0"), { DST: BLS_DST })).slice(2));
  const signature = bytesToHex(one.multiply(BigInt(n)).toRawBytes(true));
  const bits = new Uint8Array(64); for (let i = 0; i < n; i++) bits[i >> 3] |= 1 << (i & 7);
  return {
    attested_header: att, finalized_header: fin, finality_branch: branch(leaves, 169),
    next_sync_committee: o.next?.committee, next_sync_committee_branch: o.next ? branch(leaves, 87) : undefined,
    sync_aggregate: { sync_committee_bits: bytesToHex(bits), sync_committee_signature: signature }, signature_slot: String(sigSlot),
  };
}

describe("light client store (synthetic chain, real BLS)", () => {
  const start = P * PERIOD_SLOTS + 100;
  const fresh = () => { const b = bootstrap(start, A); return LightClient.fromBootstrap(spec, b.root, b.data, "electra"); };

  it("bootstraps only from the trusted root, learns the next committee, rotates into the next period", () => {
    const b = bootstrap(start, A);
    expect(() => LightClient.fromBootstrap(spec, ("0x" + "22".repeat(32)) as Hex, b.data, "electra")).toThrow(/trusted block root/);
    const lc = fresh();
    expect(lc.period).toBe(P);
    lc.applyUpdate(update({ attSlot: start + 200, finSlot: start + 150, signer: A, next: B }), "electra");
    expect(lc.knowsNextCommittee).toBe(true);
    expect(lc.finalizedSlot).toBe(start + 150);
    // the next period: signed by B, finalized in P+1 → B becomes current, C (carried) next
    const s1 = (P + 1) * PERIOD_SLOTS + 50;
    lc.applyUpdate(update({ attSlot: s1 + 100, finSlot: s1, signer: B, next: C }), "electra");
    expect(lc.period).toBe(P + 1);
    expect(lc.finalizedSlot).toBe(s1);
    // and P+2, signed by C
    const s2 = (P + 2) * PERIOD_SLOTS + 50;
    lc.applyUpdate(update({ attSlot: s2 + 100, finSlot: s2, signer: C }), "electra");
    expect(lc.period).toBe(P + 2);
    expect(lc.finalizedExecutionBlockHash()).toBe(("0x" + (s2 + 1).toString(16).padStart(64, "0")));
  });

  it("refuses: too few signers, another committee's signature, bent branches, a skipped period, a contradicting next committee", () => {
    const lc = fresh();
    expect(() => lc.applyUpdate(update({ attSlot: start + 200, finSlot: start + 150, signer: A, n: 300 }), "electra")).toThrow(/only 300 of 512/);
    expect(() => lc.applyUpdate(update({ attSlot: start + 200, finSlot: start + 150, signer: WRONG }), "electra")).toThrow(/signature does not verify/);
    const u = update({ attSlot: start + 200, finSlot: start + 150, signer: A, next: B });
    expect(() => lc.applyUpdate({ ...u, finality_branch: u.finality_branch.map((x, i) => (i === 3 ? (("0x" + "99".repeat(32)) as Hex) : x)) }, "electra")).toThrow(/finalized header is not the finalized checkpoint/);
    expect(() => lc.applyUpdate({ ...u, next_sync_committee_branch: u.next_sync_committee_branch!.map((x, i) => (i === 0 ? (("0x" + "99".repeat(32)) as Hex) : x)) }, "electra")).toThrow(/next sync committee is not in the attested state/);
    // a period ahead without knowing its committee
    const far = (P + 2) * PERIOD_SLOTS + 10;
    expect(() => lc.applyUpdate(update({ attSlot: far + 100, finSlot: far, signer: C }), "electra")).toThrow(/signed in period/);
    lc.applyUpdate(u, "electra");
    expect(() => lc.applyUpdate(update({ attSlot: start + 300, finSlot: start + 250, signer: A, next: WRONG }), "electra")).toThrow(/another next sync committee/);
    // a data format this build does not know
    expect(() => lc.applyUpdate(update({ attSlot: start + 400, finSlot: start + 350, signer: A }), "heze")).toThrow(/not one this build verifies/);
  });

  it("keeps the newest finalized header and survives a snapshot round trip", () => {
    const lc = fresh();
    lc.applyUpdate(update({ attSlot: start + 200, finSlot: start + 150, signer: A, next: B }), "electra");
    const again = LightClient.fromSnapshot(spec, JSON.parse(JSON.stringify(lc.snapshot())));
    expect(again.finalizedSlot).toBe(start + 150);
    expect(again.knowsNextCommittee).toBe(true);
    expect(() => again.applyUpdate(update({ attSlot: start + 120, finSlot: start + 100, signer: A }), "electra")).toThrow(/not newer/);
  });
});

describe("a sync in a period's first minutes (audit round 2, r26)", () => {
  const at = (period: number): BeaconChainSpec => ({ ...spec, genesisTime: Math.floor(Date.now() / 1000) - 12 * (period * PERIOD_SLOTS + 10) });
  const start = P * PERIOD_SLOTS + 100;
  /** a store of period P that knows its next committee */
  const store = (s: BeaconChainSpec) => {
    const b = bootstrap(start, A);
    const lc = LightClient.fromBootstrap(s, b.root, b.data, "electra");
    lc.applyUpdate(update({ attSlot: start + 200, finSlot: start + 150, signer: A, next: B }), "electra");
    return lc.snapshot();
  };
  // signed in P+1 by the next committee, finalizing a block of P: it verifies and does not rotate
  const late = update({ attSlot: (P + 1) * PERIOD_SLOTS + 2, finSlot: P * PERIOD_SLOTS + 8000, signer: B });
  const beacon = (updates: LightClientUpdate[]) =>
    (async (url: string) => {
      if (url.includes("/light_client/updates")) return new Response(JSON.stringify(updates.map((data) => ({ version: "electra", data }))));
      if (url.includes("/light_client/finality_update")) return new Response(JSON.stringify({ version: "electra", data: late }));
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
  it("the clock in P+1, finality still in P: the store one period behind, its next committee known, is kept — no update yet, or one that verified without rotating", async () => {
    for (const updates of [[], [late]]) {
      const s = at(P + 1);
      const lc = await syncLightClient({ spec: s, snapshot: store(s), beaconUrls: ["http://beacon.test"], fetchFn: beacon(updates) });
      expect(lc.period).toBe(P);
      expect(lc.finalizedSlot, "the finality update moved its header").toBe(P * PERIOD_SLOTS + 8000);
    }
  });
  it("still refused: a store two periods behind the clock", async () => {
    const s = at(P + 2);
    await expect(syncLightClient({ spec: s, snapshot: store(s), beaconUrls: ["http://beacon.test"], fetchFn: beacon([]) })).rejects.toThrow(/no update for sync-committee period/);
  });
});

describe("a configured checkpoint past the age limit (audit round 2, n43)", () => {
  const NOW = P + 14; // the clock: fourteen periods after the checkpoint's, past the twelve a saved store may be
  const s: BeaconChainSpec = { ...spec, genesisTime: Math.floor(Date.now() / 1000) - 12 * (NOW * PERIOD_SLOTS + 10) };
  const old = bootstrap(P * PERIOD_SLOTS + 100, A);
  const recent = bootstrap(NOW * PERIOD_SLOTS + 2, C); // the finalized root every beacon API reports
  const fu = update({ attSlot: NOW * PERIOD_SLOTS + 5, finSlot: NOW * PERIOD_SLOTS + 3, signer: C });
  const answer = (v: unknown) => new Response(JSON.stringify(v));
  const beacon = (asked: string[]) =>
    (async (url: string) => {
      asked.push(url);
      if (url.includes("/headers/finalized")) return answer({ data: { root: recent.root, header: { message: { slot: String(NOW * PERIOD_SLOTS + 2) } } } });
      if (url.includes(`/bootstrap/${old.root}`)) return answer({ version: "electra", data: old.data });
      if (url.includes(`/bootstrap/${recent.root}`)) return answer({ version: "electra", data: recent.data });
      if (url.includes("/light_client/updates")) return answer([]);
      if (url.includes("/light_client/finality_update")) return answer({ version: "electra", data: fu });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
  it("is not walked from: the beacon APIs' agreed finalized root is the start, as with no checkpoint", async () => {
    const asked: string[] = [];
    const lc = await syncLightClient({ spec: s, checkpoint: old.root, beaconUrls: ["http://beacon.test"], fetchFn: beacon(asked), maxCheckpointAgePeriods: 12 });
    expect(lc.period).toBe(NOW);
    expect(lc.finalizedSlot).toBe(NOW * PERIOD_SLOTS + 3);
    expect(asked.some((u) => u.includes(`start_period=${P}&`)), "no walk across the retired committees").toBe(false);
  });
  it("within the limit it is the start, as before; without the limit an aged one is walked from", async () => {
    const asked: string[] = [];
    await expect(syncLightClient({ spec: s, checkpoint: old.root, beaconUrls: ["http://beacon.test"], fetchFn: beacon(asked) })).rejects.toThrow(new RegExp(`no update for sync-committee period ${P}`));
    await expect(syncLightClient({ spec: s, checkpoint: old.root, beaconUrls: ["http://beacon.test"], fetchFn: beacon(asked), maxCheckpointAgePeriods: 14 })).rejects.toThrow(new RegExp(`no update for sync-committee period ${P}`));
  });
});

describe("execution proofs on hand-built tries", () => {
  const hp = (nibs: number[], leaf: boolean): Hex => { // hex-prefix encoding
    const odd = nibs.length % 2;
    const flag = (leaf ? 2 : 0) + odd;
    const all = odd ? [flag, ...nibs] : [flag, 0, ...nibs];
    const out = new Uint8Array(all.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = (all[2 * i] << 4) | all[2 * i + 1];
    return bytesToHex(out);
  };
  const nibs = (h: Hex) => { const b = hexToBytes(h); const n: number[] = []; for (const x of b) n.push(x >> 4, x & 15); return n; };
  const slotKey = (s: number) => keccak256(("0x" + s.toString(16).padStart(64, "0")) as Hex);

  it("a single-leaf trie proves its key and the absence of any other", () => {
    const key = slotKey(2);
    const leaf = toRlp([hp(nibs(key), true), toRlp("0x12")]);
    const root = keccak256(leaf);
    expect(verifyStorage(root, "0x2", [leaf])).toBe(18n);
    expect(verifyStorage(root, "0x3", [leaf])).toBe(0n); // a different key ends at this leaf: absent
    expect(() => verifyStorage(root, "0x2", [toRlp([hp(nibs(key), true), toRlp("0x13")])])).toThrow(ProofError);
  });

  it("a branch trie proves both leaves and the absence of an empty child", () => {
    // two keys whose first nibbles differ: a branch with two leaf children
    let a = 0, b = 1;
    while (nibs(slotKey(a))[0] === nibs(slotKey(b))[0]) b++;
    const la = toRlp([hp(nibs(slotKey(a)).slice(1), true), toRlp("0x01")]);
    const lb = toRlp([hp(nibs(slotKey(b)).slice(1), true), toRlp("0x02")]);
    const children: Hex[] = Array(17).fill("0x");
    children[nibs(slotKey(a))[0]] = keccak256(la);
    children[nibs(slotKey(b))[0]] = keccak256(lb);
    const br = toRlp(children);
    const root = keccak256(br);
    expect(verifyStorage(root, `0x${a.toString(16)}` as Hex, [br, la])).toBe(1n);
    expect(verifyStorage(root, `0x${b.toString(16)}` as Hex, [br, lb])).toBe(2n);
    let c = 0; while ([nibs(slotKey(a))[0], nibs(slotKey(b))[0]].includes(nibs(slotKey(c))[0])) c++;
    expect(verifyStorage(root, `0x${c.toString(16)}` as Hex, [br])).toBe(0n); // an empty child: proven absent
    expect(() => mptGet(root, hexToBytes(slotKey(a)), [br])).toThrow(/ends before the key/);
  });

  it("an execution header is accepted only by its hash, with every field in place", () => {
    const block: Record<string, string> = {
      parentHash: "0x" + "01".repeat(32), sha3Uncles: "0x" + "1d".repeat(32), miner: "0x" + "02".repeat(20), stateRoot: "0x" + "03".repeat(32), transactionsRoot: "0x" + "04".repeat(32),
      receiptsRoot: "0x" + "05".repeat(32), logsBloom: "0x" + "00".repeat(256), difficulty: "0x0", number: "0x10", gasLimit: "0x1c9c380", gasUsed: "0x5208", timestamp: "0x6553f100",
      extraData: "0x", mixHash: "0x" + "06".repeat(32), nonce: "0x0000000000000000", baseFeePerGas: "0x7", withdrawalsRoot: "0x" + "07".repeat(32), blobGasUsed: "0x0",
      excessBlobGas: "0x0", parentBeaconBlockRoot: "0x" + "08".repeat(32), requestsHash: "0x" + "09".repeat(32),
    };
    const q = (v: string) => (BigInt(v) === 0n ? "0x" : (`0x${BigInt(v).toString(16).padStart(Math.ceil(BigInt(v).toString(16).length / 2) * 2, "0")}` as Hex));
    const order = ["parentHash", "sha3Uncles", "miner", "stateRoot", "transactionsRoot", "receiptsRoot", "logsBloom", "difficulty", "number", "gasLimit", "gasUsed", "timestamp", "extraData", "mixHash", "nonce", "baseFeePerGas", "withdrawalsRoot", "blobGasUsed", "excessBlobGas", "parentBeaconBlockRoot", "requestsHash"];
    const quantities = new Set(["difficulty", "number", "gasLimit", "gasUsed", "timestamp", "baseFeePerGas", "blobGasUsed", "excessBlobGas"]);
    const hash = keccak256(toRlp(order.map((k) => (quantities.has(k) ? q(block[k]) : (block[k] as Hex)))));
    expect(verifyHeader(hash, { ...block, hash, size: "0x1", transactions: [], uncles: [] })).toMatchObject({ number: 16n, stateRoot: "0x" + "03".repeat(32) });
    expect(() => verifyHeader(hash, { ...block, stateRoot: "0x" + "33".repeat(32) })).toThrow(/does not hash/);
    expect(() => verifyHeader(hash, { ...block, newField: "0x01" })).toThrow(/unknown header field/);
    expect(() => verifyHeader(hash, { ...block, requestsHash: undefined, blockAccessListHash: "0x" + "0a".repeat(32) } as any)).toThrow(/out of order/);
  });

  it("SSZ basics: the zero-hash ladder and little-endian integers", () => {
    expect(bytesToHex(merkleize([new Uint8Array(32), new Uint8Array(32)]))).toBe("0xf5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b");
    expect(bytesToHex(uintChunk(1)).slice(0, 4)).toBe("0x01");
    expect(() => uintChunk(1n << 64n)).toThrow(/out of range/);
  });
});

void LightClientError;
