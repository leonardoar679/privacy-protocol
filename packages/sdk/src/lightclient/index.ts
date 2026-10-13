// Trustless reads for the wallet (plan §38): an Ethereum light client that ends in proven contract storage.
//   1. start from a trusted beacon block root — configured (VITE_LC_CHECKPOINT), the wallet's own saved
//      store, or, on first use, a finalized root every configured beacon API reports identically;
//   2. follow the sync committees period by period and accept the latest finalized header only with a
//      2/3 sync-committee signature (beacon.ts);
//   3. take that header's execution block, fetch its header from any RPC and accept it only if it hashes
//      to the proven block hash; read contract storage with eth_getProof against its state root
//      (execution.ts).
// Beacon APIs and RPCs are couriers: what they hand over is checked, never believed.
import { fetchFor } from "@privacy-wallet/privacy-engine/transport/http";
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
}

/** A finalized block root that every reachable configured beacon API reports for the same slot (trust on first use, cross-checked). */
export async function agreedFinalizedRoot(urls: string[], fetchFn: typeof fetch = fetchFor("beacon")): Promise<Hex> {
  const [first, ...rest] = urls.map((u) => beaconApi(u, fetchFn));
  const head = (await first<{ data: { root: Hex; header: { message: { slot: string } } } }>("/eth/v1/beacon/headers/finalized")).data;
  const slot = head.header.message.slot;
  for (const [i, api] of rest.entries()) {
    const other = (await api<{ data: { root: Hex } }>(`/eth/v1/beacon/headers/${slot}`)).data.root;
    if (other.toLowerCase() !== head.root.toLowerCase()) throw new LightClientError(`light client: beacon APIs disagree on the block at finalized slot ${slot} (${urls[0]} vs ${urls[i + 1]})`);
  }
  return head.root.toLowerCase() as Hex;
}

/** Bring a light client to the latest finalized header the network has signed. */
export async function syncLightClient(o: SyncOptions): Promise<LightClient> {
  const urls = o.beaconUrls?.length ? o.beaconUrls : o.spec.beaconApis;
  // every answer is verified, so any configured API may serve any request: fail over in order
  const apis = urls.map((u) => beaconApi(u, o.fetchFn));
  const api = async <T,>(path: string): Promise<T> => {
    let last: unknown;
    for (const a of apis) { try { return await a<T>(path); } catch (e) { last = e; } }
    throw last;
  };
  let lc: LightClient;
  if (o.snapshot) lc = LightClient.fromSnapshot(o.spec, o.snapshot);
  else {
    const root = o.checkpoint ?? (await agreedFinalizedRoot(urls, o.fetchFn));
    const b = await api<Versioned<LightClientBootstrap>>(`/eth/v1/beacon/light_client/bootstrap/${root}`);
    lc = LightClient.fromBootstrap(o.spec, root, b.data, b.version);
  }
  // walk the committees: while the next one is unknown, the store's own period's update teaches it;
  // then each following period's update (signed by that committee) moves the store into it
  const target = periodAtSlot(currentSlot(o.spec));
  const update = async (period: number) => {
    const us = await api<Versioned<LightClientUpdate>[]>(`/eth/v1/beacon/light_client/updates?start_period=${period}&count=1`);
    if (!us.length) throw new LightClientError(`light client: no update for sync-committee period ${period}`);
    lc.applyUpdate(us[0].data, us[0].version);
  };
  for (let walked = 0; lc.period < target; walked++) {
    if (walked >= (o.maxPeriods ?? 512)) throw new LightClientError(`light client: more than ${o.maxPeriods ?? 512} sync-committee periods to walk; start from a newer checkpoint`);
    const before = `${lc.period}|${lc.knowsNextCommittee}`;
    await update(lc.knowsNextCommittee ? lc.period + 1 : lc.period);
    if (`${lc.period}|${lc.knowsNextCommittee}` === before) throw new LightClientError(`light client: the update after period ${lc.period} did not advance the store`);
  }
  // best effort: a finality update signed just after the period boundary needs the next committee
  if (!lc.knowsNextCommittee) await update(lc.period).catch(() => undefined);
  const fu = await api<Versioned<LightClientUpdate>>("/eth/v1/beacon/light_client/finality_update");
  if (Number(fu.data.finalized_header.beacon.slot) > lc.finalizedSlot) lc.applyUpdate({ ...fu.data, next_sync_committee: undefined, next_sync_committee_branch: undefined }, fu.version);
  return lc;
}

async function rpc<T>(urls: string[], method: string, params: unknown[], fetchFn: typeof fetch): Promise<T> {
  let last: unknown;
  for (const url of urls) {
    try {
      const r = await fetchFn(url, { method: "POST", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message ?? String(j.error));
      if (j.result === null || j.result === undefined) throw new Error(`${method}: no result`);
      return j.result as T;
    } catch (e) { last = e; }
  }
  throw new Error(`no RPC answered ${method}: ${String((last as Error)?.message ?? last)}`);
}

export interface ProvenStorage { header: VerifiedHeader; account: VerifiedAccount; values: bigint[] }

/** Storage of `address` at the light client's finalized execution block, every word proven. */
export async function provenStorage(lc: LightClient, rpcUrls: string[], address: Address, slots: Hex[], fetchFn: typeof fetch = fetchFor("rpc")): Promise<ProvenStorage> {
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
