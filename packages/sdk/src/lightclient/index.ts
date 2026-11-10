// Trustless reads for the wallet (plan §38): an Ethereum light client that ends in proven contract storage.
//   1. start from a trusted beacon block root — configured (VITE_LC_CHECKPOINT), the wallet's own saved
//      store, or, on first use, a finalized root every configured beacon API reports identically (a store and a
//      configured checkpoint only within the age limit: ../verifiedReads.ts MAX_SNAPSHOT_AGE_PERIODS);
//   2. follow the sync committees period by period and accept the latest finalized header only with a
//      2/3 sync-committee signature (beacon.ts);
//   3. take that header's execution block, fetch its header from any RPC and accept it only if it hashes
//      to the proven block hash; read contract storage with eth_getProof against its state root
//      (execution.ts).
// Beacon APIs and RPCs are couriers: what they hand over is checked, never believed.
import { fetchFor, readCapped, RPC_ANSWER_MAX_BYTES } from "@privacy-wallet/privacy-engine/transport/http";
import { getAddress, toHex, type Address, type Hex } from "viem";
import { LightClient, LightClientError, beaconApi, type LightClientBootstrap, type LightClientUpdate, type StoreSnapshot } from "./beacon";
import { verifyAccount, verifyHeader, verifyStorage, type AccountProof, type VerifiedAccount, type VerifiedHeader } from "./execution";
import { currentSlot, periodAtSlot, type BeaconChainSpec } from "./spec";

export { LightClient, LightClientError, type StoreSnapshot } from "./beacon";
export { ProofError, mappingSlot } from "./execution";
export { MAINNET, SEPOLIA, specForChain, type BeaconChainSpec } from "./spec";

type Versioned<T> = { version: string; data: T };

export interface SyncOptions {
  spec: BeaconChainSpec;
  beaconUrls?: string[];
  /** a beacon block root the user trusts (weak subjectivity checkpoint) */
  checkpoint?: Hex;
  /** a store this wallet verified before */
  snapshot?: StoreSnapshot;
  fetchFn?: typeof fetch;
  /** at most this many sync-committee periods are walked in one sync (≈ 27 h each) */
  maxPeriods?: number;
  /** a checkpoint more periods behind the clock than this is not walked from (audit round 2, n43): the agreed finalized root is the start */
  maxCheckpointAgePeriods?: number;
}

/** A beacon API's header answer (beacon-APIs `headers/{block_id}`): the top-level `finalized` says whether the block is final. */
interface HeaderAnswer { finalized?: boolean; data: { root: Hex; header: { message: { slot: string } } } }
// the host's name, without its port (the ninth review round, 2026-11-04, D-10): one host on two ports had passed as two
const hostOf = (u: string): string => { try { return new URL(u).hostname.toLowerCase(); } catch { return u.toLowerCase(); } };

/**
 * A finalized block root every configured beacon API reports identically (trust on first use, cross-checked). The fourth review
 * round (2026-11-03): the first API had named the slot, and the others confirmed the root at that slot alone — neither its finality
 * nor its age was checked, so one API listed first could anchor the client at its unfinalized head (any later reorg then
 * "proven" away) or at a years-old slot whose retired committee's keys it held. Now every API answers its own finalized header,
 * each must say `finalized`, the lowest slot is taken, every API must report the same root as finalized at that slot, the slot must
 * be within the age limit a saved store has, and a first use needs two distinct hosts to agree.
 */
export async function agreedFinalizedRoot(urls: string[], fetchFn: typeof fetch = fetchFor("beacon"), o: { spec?: BeaconChainSpec; maxAgePeriods?: number } = {}): Promise<Hex> {
  if (new Set(urls.map(hostOf)).size < 2)
    throw new LightClientError("light client: a first use needs two beacon APIs on different hosts to agree on a finalized root (one alone could name any block); configure VITE_BEACON_URLS with two, or a checkpoint (VITE_LC_CHECKPOINT)");
  const apis = urls.map((u) => beaconApi(u, fetchFn));
  const own = await Promise.all(apis.map((a) => a<HeaderAnswer>("/eth/v1/beacon/headers/finalized")));
  for (const [i, h] of own.entries()) if (h.finalized !== true) throw new LightClientError(`light client: ${urls[i]} does not report its finalized header as finalized`);
  const slots = own.map((h) => Number(h.data.header.message.slot));
  if (slots.some((s) => !Number.isSafeInteger(s) || s <= 0)) throw new LightClientError("light client: a beacon API answered a finalized header without a slot");
  const slot = Math.min(...slots);
  if (o.spec && o.maxAgePeriods !== undefined && periodAtSlot(currentSlot(o.spec)) - periodAtSlot(slot) > o.maxAgePeriods)
    throw new LightClientError(`light client: the beacon APIs' finalized slot ${slot} is more than ${o.maxAgePeriods} sync-committee periods behind the clock: not a start`);
  const at = await Promise.all(apis.map((a) => a<HeaderAnswer>(`/eth/v1/beacon/headers/${slot}`)));
  const root = at[0].data.root.toLowerCase();
  for (const [i, h] of at.entries()) {
    if (h.finalized !== true) throw new LightClientError(`light client: ${urls[i]} does not report the block at slot ${slot} as finalized`);
    if (h.data.root.toLowerCase() !== root) throw new LightClientError(`light client: beacon APIs disagree on the block at finalized slot ${slot} (${urls[0]} vs ${urls[i]})`);
  }
  return root as Hex;
}

/** Bring a light client to the latest finalized header the network has signed. */
export async function syncLightClient(o: SyncOptions): Promise<LightClient> {
  const urls = o.beaconUrls?.length ? o.beaconUrls : o.spec.beaconApis;
  // every answer is verified, so any configured API may serve any request: fail over in order — on a failed request, and on
  // an answer that does not verify (audit round 2, n39): the first API's bad answer had stopped the light client, and every
  // spend with it, though the next API would have served a valid one. `use` verifies and applies; it changes nothing on a throw
  const apis = urls.map((u) => beaconApi(u, o.fetchFn));
  // from the API at `from` on; which one served is returned, so a caller can ask past it (the ninth review round, 2026-11-04, D-5)
  const verifiedAt = async <T, R>(path: string, use: (answer: T) => R, from = 0): Promise<{ r: R; at: number }> => {
    let last: unknown = new LightClientError("light client: no beacon API left to ask");
    for (let i = from; i < apis.length; i++) {
      try {
        return { r: use(await apis[i]<T>(path)), at: i };
      } catch (e) {
        last = e;
      }
    }
    throw last;
  };
  const verified = async <T, R>(path: string, use: (answer: T) => R): Promise<R> => (await verifiedAt(path, use)).r;
  let lc: LightClient;
  const fromRoot = (root: Hex): Promise<LightClient> =>
    verified<Versioned<LightClientBootstrap>, LightClient>(`/eth/v1/beacon/light_client/bootstrap/${root}`, (b) => LightClient.fromBootstrap(o.spec, root, b.data, b.version));
  if (o.snapshot) lc = LightClient.fromSnapshot(o.spec, o.snapshot);
  else {
    lc = await fromRoot(o.checkpoint ?? (await agreedFinalizedRoot(urls, o.fetchFn, { spec: o.spec, maxAgePeriods: o.maxCheckpointAgePeriods })));
    // a configured checkpoint past the age limit is replaced as a saved store is (audit round 2, n43): a store discarded for its
    // age had been replaced by the checkpoint even when that was older still — walked across the long-retired committees the
    // limit keeps out, or failing once the beacon APIs no longer served that range
    if (o.checkpoint && o.maxCheckpointAgePeriods !== undefined && periodAtSlot(currentSlot(o.spec)) - lc.period > o.maxCheckpointAgePeriods)
      lc = await fromRoot(await agreedFinalizedRoot(urls, o.fetchFn, { spec: o.spec, maxAgePeriods: o.maxCheckpointAgePeriods }));
  }
  // walk the committees: while the next one is unknown, the store's own period's update teaches it;
  // then each following period's update (signed by that committee) moves the store into it
  const target = periodAtSlot(currentSlot(o.spec));
  /** The period's update from the APIs at `from` on; the index of the one that served it. */
  const update = async (period: number, from = 0): Promise<number> => {
    let none = false; // an API answered that it has none: the period's boundary is read from that, whatever the others did
    try {
      return (
        await verifiedAt<Versioned<LightClientUpdate>[], void>(
          `/eth/v1/beacon/light_client/updates?start_period=${period}&count=1`,
          (us) => {
            if (!us.length) {
              none = true;
              throw new LightClientError(`light client: no update for sync-committee period ${period}`);
            }
            lc.applyUpdate(us[0].data, us[0].version);
          },
          from,
        )
      ).at;
    } catch (e) {
      if (none) throw new LightClientError(`light client: no update for sync-committee period ${period}`);
      throw e;
    }
  };
  for (let walked = 0; lc.period < target; walked++) {
    if (walked >= (o.maxPeriods ?? 512)) throw new LightClientError(`light client: more than ${o.maxPeriods ?? 512} sync-committee periods to walk; start from a newer checkpoint`);
    const before = `${lc.period}|${lc.knowsNextCommittee}`;
    // a period's first minutes (audit round 2, r26): the clock is in P+1 while finality stays in P for 2–3 epochs. The store
    // one period behind, its next committee known, is valid for these reads (the next period's update is not there yet, or
    // it verified without rotating): the walk ends there, and the finality update moves its header as always. Every
    // verified operation had failed for those minutes of every period
    const boundary = lc.period === target - 1 && lc.knowsNextCommittee;
    // an update that verifies without advancing the store is the API's dead end, not the walk's (the ninth review round, 2026-11-04, D-5): the
    // next API is asked — a genuine update of the next period that finalizes a block of this one had stopped the walk, the API that would
    // have served the rotation never asked
    const period = lc.knowsNextCommittee ? lc.period + 1 : lc.period;
    let from = 0;
    let advanced = false;
    let ended = false;
    while (!advanced && from < apis.length) {
      try {
        from = (await update(period, from)) + 1;
      } catch (e) {
        // at the boundary the store one period behind is valid for these reads (r26): an API that has no update ends the walk, and so does
        // any failure once an API served a verified update that did not advance the store (the tenth review round, B10-4: the second API
        // down had thrown the whole sync, where the store had stood before the ninth round)
        if (boundary && (from > 0 || (e instanceof LightClientError && /no update for sync-committee period/.test(e.message)))) {
          ended = true;
          break;
        }
        throw e;
      }
      advanced = `${lc.period}|${lc.knowsNextCommittee}` !== before;
    }
    if (ended) break;
    if (!advanced) {
      if (boundary) break;
      throw new LightClientError(`light client: the update after period ${lc.period} did not advance the store`);
    }
  }
  // best effort: a finality update signed just after the period boundary needs the next committee
  if (!lc.knowsNextCommittee) await update(lc.period).catch(() => undefined);
  // the finality update moves the walked store's header when one verifies; when none does — a local clock more than
  // CLOCK_SLACK_SLOTS slow refuses the newest, or no API serves one — the walked store stands, valid as it is (audit round 2,
  // n40: the whole sync had thrown)
  try {
    await verified<Versioned<LightClientUpdate>, void>("/eth/v1/beacon/light_client/finality_update", (fu) => {
      // one not newer than the store is that API's lag: the next is asked (the ninth review round, D-5) — an older genuine update, served
      // first, had left the store behind, and every verified read refused once the lag passed twelve epochs
      if (Number(fu.data.finalized_header.beacon.slot) <= lc.finalizedSlot) throw new LightClientError("light client: a finality update not newer than the store");
      lc.applyUpdate({ ...fu.data, next_sync_committee: undefined, next_sync_committee_branch: undefined }, fu.version);
    });
  } catch {
    /* the walked store stands */
  }
  return lc;
}

async function rpc<T>(urls: string[], method: string, params: unknown[], fetchFn: typeof fetch): Promise<T> {
  let last: unknown;
  for (const url of urls) {
    try {
      const r = await fetchFn(url, { method: "POST", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
      // bounded as the transport bounds the endpoints' answers (the twelfth review round, ZI's critique): read whole, an endless answer had
      // filled the tab for the read's 20 s
      const j = JSON.parse(await readCapped(r, RPC_ANSWER_MAX_BYTES));
      if (j.error) throw new Error(j.error.message ?? String(j.error));
      if (j.result === null || j.result === undefined) throw new Error(`${method}: no result`);
      return j.result as T;
    } catch (e) { last = e; }
  }
  throw new Error(`no RPC answered ${method}: ${String((last as Error)?.message ?? last)}`);
}

export interface ProvenStorage { header: VerifiedHeader; account: VerifiedAccount; values: bigint[] }

/**
 * Storage of `address` at the light client's finalized execution block, every word proven — from the first endpoint whose answers verify
 * (the ninth review round, 2026-11-04, D-5: one endpoint's proof that did not verify had ended the read, the next never asked).
 */
export async function provenStorage(lc: LightClient, rpcUrls: string[], address: Address, slots: Hex[], fetchFn: typeof fetch = fetchFor("rpc")): Promise<ProvenStorage> {
  let last: unknown = new Error("no RPC endpoint is configured for the proofs");
  for (const url of rpcUrls) {
    try {
      return await provenStorageAt(lc, url, address, slots, fetchFn);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function provenStorageAt(lc: LightClient, url: string, address: Address, slots: Hex[], fetchFn: typeof fetch): Promise<ProvenStorage> {
  const rpcUrls = [url];
  const blockHash = lc.finalizedExecutionBlockHash();
  const header = verifyHeader(blockHash, await rpc<Record<string, unknown>>(rpcUrls, "eth_getBlockByHash", [blockHash, false], fetchFn));
  const proof = await rpc<AccountProof>(rpcUrls, "eth_getProof", [getAddress(address), slots.map((s) => toHex(BigInt(s), { size: 32 })), toHex(header.number)], fetchFn);
  if (proof.address.toLowerCase() !== address.toLowerCase()) throw new Error("eth_getProof answered for another address");
  const account = verifyAccount(header.stateRoot, proof);
  if (proof.storageProof.length !== slots.length) throw new Error("eth_getProof returned a different number of storage proofs");
  const values = slots.map((s, i) => {
    const sp = proof.storageProof[i];
    if (BigInt(sp.key) !== BigInt(s)) throw new Error(`eth_getProof answered for slot ${sp.key}, not ${s}`);
    const v = verifyStorage(account.storageRoot, s, sp.proof);
    if (BigInt(sp.value) !== v) throw new Error(`the RPC's value for slot ${s} disagrees with its proof`);
    return v;
  });
  return { header, account, values };
}
