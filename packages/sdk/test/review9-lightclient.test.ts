// The ninth review round (2026-11-04), the light client (D-5, D-8): one beacon API can no longer stop or stale it with genuine data — an
// update that verifies without advancing the store, or a finality update older than the store's, sends the walk to the next API — and the
// data's layout is the attested slot's fork on this chain, never the API's label alone. The reviewer's probe P8 (a synthetic chain: real
// BLS, sparse SSZ states; the helpers follow apps/web/test/lightclient.test.ts) became these cases.
import { describe, expect, it } from "vitest";
import { bls12_381 } from "@noble/curves/bls12-381";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { LightClient } from "../src/lightclient/beacon";
import type { LightClientBootstrap, LightClientHeader, LightClientUpdate } from "../src/lightclient/beacon";
import {
  beaconBlockHeaderRoot,
  computeDomain,
  executionPayloadHeaderDenebRoot,
  hashPair,
  signingRoot,
  syncCommitteeRoot,
  type SyncCommittee,
} from "../src/lightclient/ssz";
import { BLS_DST, DOMAIN_SYNC_COMMITTEE, type BeaconChainSpec } from "../src/lightclient/spec";
import { syncLightClient } from "../src/lightclient";

const PERIOD_SLOTS = 8192;
const baseSpec: BeaconChainSpec = {
  name: "test",
  chainId: 999n,
  genesisTime: 0,
  genesisValidatorsRoot: ("0x" + "11".repeat(32)) as Hex,
  forks: [
    { name: "phase0", version: "0x00000001", epoch: 0 },
    { name: "electra", version: "0x05000001", epoch: 0 },
  ],
  beaconApis: [],
};
const at = (period: number, slot = 10): BeaconChainSpec => ({ ...baseSpec, genesisTime: Math.floor(Date.now() / 1000) - 12 * (period * PERIOD_SLOTS + slot) });
const P = 5;

const ZERO = new Uint8Array(32);
function treeRoot(fixed: Map<number, Uint8Array>, g = 1): Uint8Array {
  if (fixed.has(g)) return fixed.get(g)!;
  const below = [...fixed.keys()].some((k) => {
    let x = k;
    while (x > g) x >>= 1;
    return x === g;
  });
  if (!below) return zeroAt(depthBelow(fixed, g));
  return hashPair(treeRoot(fixed, 2 * g), treeRoot(fixed, 2 * g + 1));
}
const maxDepth = (fixed: Map<number, Uint8Array>) => Math.max(...[...fixed.keys()].map((k) => 31 - Math.clz32(k)));
const depthBelow = (fixed: Map<number, Uint8Array>, g: number) => maxDepth(fixed) - (31 - Math.clz32(g));
const zeroCache: Uint8Array[] = [ZERO];
function zeroAt(d: number): Uint8Array {
  while (zeroCache.length <= d) zeroCache.push(hashPair(zeroCache[zeroCache.length - 1], zeroCache[zeroCache.length - 1]));
  return zeroCache[Math.max(d, 0)];
}
function branch(fixed: Map<number, Uint8Array>, g: number): Hex[] {
  const out: Hex[] = [];
  for (let x = g; x > 1; x >>= 1) out.push(bytesToHex(treeRoot(fixed, x ^ 1)));
  return out;
}

interface Keys {
  sk: bigint;
  committee: SyncCommittee;
}
function keys(seed: number): Keys {
  const sk = BigInt(1000 + seed);
  const pk = bytesToHex(bls12_381.getPublicKey(sk.toString(16).padStart(64, "0")));
  return { sk, committee: { pubkeys: Array(512).fill(pk), aggregate_pubkey: pk } };
}
const A = keys(1),
  B = keys(2),
  C = keys(3);
type Fmt = "electra" | "gloas";
const G = { electra: { fin: 169, cur: 86, next: 87, exec: 25 }, gloas: { fin: 735, cur: 2945, next: 2946, exec: 2856 } };

function execHeader(n: number) {
  return {
    parent_hash: ("0x" + "01".repeat(32)) as Hex,
    fee_recipient: ("0x" + "02".repeat(20)) as Hex,
    state_root: ("0x" + n.toString(16).padStart(64, "0")) as Hex,
    receipts_root: ("0x" + "03".repeat(32)) as Hex,
    logs_bloom: ("0x" + "00".repeat(256)) as Hex,
    prev_randao: ("0x" + "04".repeat(32)) as Hex,
    block_number: String(n),
    gas_limit: "30000000",
    gas_used: "21000",
    timestamp: "1700000000",
    extra_data: "0x6e696365" as Hex,
    base_fee_per_gas: "7",
    block_hash: ("0x" + (n + 1).toString(16).padStart(64, "0")) as Hex,
    transactions_root: ("0x" + "05".repeat(32)) as Hex,
    withdrawals_root: ("0x" + "06".repeat(32)) as Hex,
    blob_gas_used: "0",
    excess_blob_gas: "0",
  };
}
function header(slot: number, stateLeaves: Map<number, Uint8Array>, fmt: Fmt = "electra"): LightClientHeader {
  const stateRoot = bytesToHex(treeRoot(stateLeaves.size ? stateLeaves : new Map([[2, ZERO]])));
  if (fmt === "gloas") {
    const blockHash = ("0x" + (slot + 1).toString(16).padStart(64, "0")) as Hex;
    const body = new Map([
      [G.gloas.exec, hexToBytes(blockHash)],
      [3, hexToBytes(("0x" + "77".repeat(32)) as Hex)],
    ]);
    return {
      beacon: {
        slot: String(slot),
        proposer_index: "7",
        parent_root: ("0x" + "aa".repeat(32)) as Hex,
        state_root: stateRoot,
        body_root: bytesToHex(treeRoot(body)),
      },
      execution_block_hash: blockHash,
      execution_branch: branch(body, G.gloas.exec),
    };
  }
  const execution = execHeader(slot);
  const body = new Map([
    [25, executionPayloadHeaderDenebRoot(execution)],
    [24, hexToBytes(("0x" + "77".repeat(32)) as Hex)],
  ]);
  return {
    beacon: {
      slot: String(slot),
      proposer_index: "7",
      parent_root: ("0x" + "aa".repeat(32)) as Hex,
      state_root: stateRoot,
      body_root: bytesToHex(treeRoot(body)),
    },
    execution,
    execution_branch: branch(body, 25),
  };
}
const rootOf = (h: LightClientHeader) => bytesToHex(beaconBlockHeaderRoot(h.beacon));
function bootstrap(slot: number, current: Keys, fmt: Fmt = "electra"): { root: Hex; data: LightClientBootstrap } {
  const leaves = new Map([
    [G[fmt].cur, syncCommitteeRoot(current.committee)],
    [G[fmt].next, ZERO],
  ]);
  const h = header(slot, leaves, fmt);
  return { root: rootOf(h), data: { header: h, current_sync_committee: current.committee, current_sync_committee_branch: branch(leaves, G[fmt].cur) } };
}
function update(o: { attSlot: number; finSlot: number; signer: Keys; next?: Keys; fmt?: Fmt; spec: BeaconChainSpec }): LightClientUpdate {
  const fmt = o.fmt ?? "electra";
  const fin = header(o.finSlot, new Map(), fmt);
  const leaves = new Map<number, Uint8Array>([
    [G[fmt].fin, beaconBlockHeaderRoot(fin.beacon)],
    [G[fmt].next, o.next ? syncCommitteeRoot(o.next.committee) : ZERO],
  ]);
  const att = header(o.attSlot, leaves, fmt);
  const domain = computeDomain(DOMAIN_SYNC_COMMITTEE, o.spec.forks[1].version, o.spec.genesisValidatorsRoot);
  const msg = signingRoot(beaconBlockHeaderRoot(att.beacon), domain);
  const one = bls12_381.G2.ProjectivePoint.fromHex(bytesToHex(bls12_381.sign(msg, o.signer.sk.toString(16).padStart(64, "0"), { DST: BLS_DST })).slice(2));
  const signature = bytesToHex(one.multiply(512n).toRawBytes(true));
  const bits = new Uint8Array(64).fill(0xff);
  return {
    attested_header: att,
    finalized_header: fin,
    finality_branch: branch(leaves, G[fmt].fin),
    next_sync_committee: o.next?.committee,
    next_sync_committee_branch: o.next ? branch(leaves, G[fmt].next) : undefined,
    sync_aggregate: { sync_committee_bits: bytesToHex(bits), sync_committee_signature: signature },
    signature_slot: String(o.attSlot + 1),
  };
}
const answer = (v: unknown) => new Response(JSON.stringify(v));
type Api = { updates?: Record<number, LightClientUpdate[]>; finality?: LightClientUpdate };
const beacons = (by: Record<string, Api>) =>
  (async (url: string) => {
    const api = by[new URL(url).host];
    const m = /start_period=(\d+)/.exec(url);
    if (m) return answer((api.updates?.[Number(m[1])] ?? []).map((data) => ({ version: "electra", data })));
    if (url.includes("/light_client/finality_update"))
      return api.finality ? answer({ version: "electra", data: api.finality }) : new Response("{}", { status: 404 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

describe("D-5 (i): an update that verifies without advancing the store", () => {
  const s = at(P + 2);
  const start = P * PERIOD_SLOTS + 100;
  const store = () => {
    const b = bootstrap(start, A);
    const lc = LightClient.fromBootstrap(s, b.root, b.data, "electra");
    lc.applyUpdate(update({ attSlot: start + 200, finSlot: start + 150, signer: A, next: B, spec: s }), "electra");
    return lc.snapshot();
  };
  // signed in P+1, finalizing a block of P: genuine, and no rotation
  const notRotating = update({ attSlot: (P + 1) * PERIOD_SLOTS + 2, finSlot: P * PERIOD_SLOTS + 8000, signer: B, spec: s });
  const rotating = update({ attSlot: (P + 1) * PERIOD_SLOTS + 300, finSlot: (P + 1) * PERIOD_SLOTS + 200, signer: B, next: C, spec: s });
  const nextPeriod = update({ attSlot: (P + 2) * PERIOD_SLOTS + 5, finSlot: (P + 2) * PERIOD_SLOTS + 2, signer: C, spec: s });
  const apis = {
    "first.test": { updates: { [P + 1]: [notRotating], [P + 2]: [nextPeriod] } },
    "second.test": { updates: { [P + 1]: [rotating], [P + 2]: [nextPeriod] } },
  };
  it("is the first API's dead end: the second is asked, and the walk reaches the clock's period whichever API is listed first", async () => {
    for (const urls of [
      ["http://first.test", "http://second.test"],
      ["http://second.test", "http://first.test"],
    ]) {
      const lc = await syncLightClient({ spec: s, snapshot: store(), beaconUrls: urls, fetchFn: beacons(apis) });
      expect(lc.period, urls.join(" then ")).toBe(P + 2);
    }
  });
  it("no API advancing it still stops the walk, as before", async () => {
    const stuck = { "first.test": { updates: { [P + 1]: [notRotating] } }, "second.test": { updates: { [P + 1]: [notRotating] } } };
    await expect(
      syncLightClient({ spec: s, snapshot: store(), beaconUrls: ["http://first.test", "http://second.test"], fetchFn: beacons(stuck) }),
    ).rejects.toThrow(/did not advance the store/);
  });
});

describe("D-5 (ii): a finality update older than the store's", () => {
  const s = at(P, 8000);
  const start = P * PERIOD_SLOTS + 100;
  const store = () => {
    const b = bootstrap(start, A);
    const lc = LightClient.fromBootstrap(s, b.root, b.data, "electra");
    lc.applyUpdate(update({ attSlot: start + 2000, finSlot: start + 1900, signer: A, next: B, spec: s }), "electra");
    return lc.snapshot();
  };
  const stale = update({ attSlot: start + 1000, finSlot: start + 900, signer: A, spec: s });
  const newest = update({ attSlot: P * PERIOD_SLOTS + 7990, finSlot: P * PERIOD_SLOTS + 7950, signer: A, spec: s });
  const apis = { "first.test": { finality: stale }, "second.test": { finality: newest } };
  it("is the first API's lag: the second's newer one moves the store, whichever API is listed first", async () => {
    for (const urls of [
      ["http://first.test", "http://second.test"],
      ["http://second.test", "http://first.test"],
    ]) {
      const lc = await syncLightClient({ spec: s, snapshot: store(), beaconUrls: urls, fetchFn: beacons(apis) });
      expect(lc.finalizedSlot, urls.join(" then ")).toBe(P * PERIOD_SLOTS + 7950);
    }
  });
  it("none newer: the walked store stands", async () => {
    const lc = await syncLightClient({
      spec: s,
      snapshot: store(),
      beaconUrls: ["http://first.test"],
      fetchFn: beacons({ "first.test": { finality: stale } }),
    });
    expect(lc.finalizedSlot).toBe(start + 1900);
  });
});

describe("D-8: the layout is the slot's fork on this chain", () => {
  it("a bootstrap or an update labelled gloas on a chain whose schedule has no gloas is refused", () => {
    const s = at(P, 3000);
    const start = P * PERIOD_SLOTS + 100;
    expect(s.forks.map((f) => f.name)).not.toContain("gloas");
    const g = bootstrap(start, A, "gloas");
    expect(() => LightClient.fromBootstrap(s, g.root, g.data, "gloas")).toThrow(/labelled gloas/);
    const b = bootstrap(start, A);
    const lc = LightClient.fromBootstrap(s, b.root, b.data, "electra");
    expect(() => lc.applyUpdate(update({ attSlot: start + 200, finSlot: start + 150, signer: A, next: B, fmt: "gloas", spec: s }), "gloas")).toThrow(
      /labelled gloas/,
    );
    lc.applyUpdate(update({ attSlot: start + 200, finSlot: start + 150, signer: A, next: B, spec: s }), "electra");
    expect(lc.finalizedSlot).toBe(start + 150);
  });
});
