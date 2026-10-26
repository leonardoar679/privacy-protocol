// The relayer registry on chain (spec v3.0 §7.5; the original UI's discovery): the RelayerRegistered events of the
// registry, each relayer's ENS name resolved to its owner and to the `url` text record of `mainnet-tornado.<name>`, its
// registration and stake read from the registry — and the original's rules over them: the ENS owner is the registered
// address, the record names a host without a scheme, the relayer is registered, the stake is at least the floor. Pure
// over an injected JSON-RPC function; shared by the discovery script (classic/scripts/relayers.mjs) and the live suite.
import { keccak256 } from "js-sha3";
import type { Hex, RawLog } from "../history/events.ts";
import type { Rpc } from "../history/sync.ts";

export const RELAYER_REGISTRY = "0x58e8dcc13be9780fc42e8723d8ead4cf46943df2" as const;
export const RELAYER_AGGREGATOR = "0xe8f47a78a6d52d317d0d2fffac56739fe14d1b49" as const;
export const ENS_REGISTRY = "0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e" as const;
/** the ENS subdomain whose `url` text record names a relayer's mainnet host (the original UI's ensSubdomainKey) */
export const SUBDOMAIN = "mainnet-tornado";
/** the block the original UI read the registry's events from */
export const REGISTRY_FROM_BLOCK = 14_173_129;
/** the original UI's floor: 40 TORN (the registry's own minimum for a new registration is read live) */
export const MIN_STAKE_WEI = 40n * 10n ** 18n;

export const REGISTERED_TOPIC = ("0x" + keccak256("RelayerRegistered(bytes32,string,address,uint256)")) as Hex;
const selector = (signature: string): string => "0x" + keccak256(signature).slice(0, 8);
export const REGISTRY_SELECTORS = Object.freeze({
  owner: selector("owner(bytes32)"),
  resolver: selector("resolver(bytes32)"),
  text: selector("text(bytes32,string)"),
  isRelayerRegistered: selector("isRelayerRegistered(address,address)"),
  getRelayerBalance: selector("getRelayerBalance(address)"),
  isRelayer: selector("isRelayer(address)"),
  minStakeAmount: selector("minStakeAmount()"),
});

const word = (x: bigint | number): string => BigInt(x).toString(16).padStart(64, "0");
const addressWord = (a: string): string => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));

/** ENS namehash: keccak256 over the labels from the root (ASCII names lowercased; the registry's names are). */
export function namehash(name: string): Hex {
  let node = "00".repeat(32);
  if (name) for (const label of name.toLowerCase().split(".").reverse()) node = keccak256(bytesOf(node + keccak256(label)));
  return `0x${node}`;
}

/** An ABI-encoded dynamic string's return data. */
export function decodeString(returnData: string): string {
  const d = returnData.replace(/^0x/, "");
  if (d.length < 128) return "";
  const offset = Number(BigInt("0x" + d.slice(0, 64))) * 2;
  const length = Number(BigInt("0x" + d.slice(offset, offset + 64)));
  return new TextDecoder().decode(bytesOf(d.slice(offset + 64, offset + 64 + length * 2)));
}

/** `text(node, key)` call data. */
export function encodeText(node: Hex, key: string): string {
  const k = hexOf(utf8(key));
  return REGISTRY_SELECTORS.text + node.slice(2) + word(0x40) + word(k.length / 2) + k.padEnd(Math.ceil(k.length / 64) * 64, "0");
}

export interface Registration {
  blockNumber: number;
  relayerHash: Hex;
  ensName: string;
  relayerAddress: Hex;
  stakeWei: bigint;
}

/** RelayerRegistered(bytes32 relayer, string ensName, address relayerAddress, uint256 stakedAmount): nothing indexed. */
export function decodeRegistered(log: RawLog): Registration {
  if (log.topics[0]?.toLowerCase() !== REGISTERED_TOPIC) throw new Error("not a RelayerRegistered log");
  const d = log.data.replace(/^0x/, "");
  const w = (i: number) => d.slice(64 * i, 64 * (i + 1));
  const offset = Number(BigInt("0x" + w(1))) * 2;
  const length = Number(BigInt("0x" + d.slice(offset, offset + 64)));
  return {
    blockNumber: Number.parseInt(log.blockNumber, 16),
    relayerHash: `0x${w(0)}`,
    ensName: new TextDecoder().decode(bytesOf(d.slice(offset + 64, offset + 64 + length * 2))),
    relayerAddress: `0x${w(2).slice(24)}`,
    stakeWei: BigInt("0x" + w(3)),
  };
}

const hex = (n: number) => `0x${n.toString(16)}`;

/** Every registration from the registry's first block to `toBlock`, in windows halved on a refusal. */
export async function fetchRegistrations(rpc: Rpc, toBlock: number, { fromBlock = REGISTRY_FROM_BLOCK, window = 2_000_000 } = {}): Promise<Registration[]> {
  const out: Registration[] = [];
  let from = fromBlock;
  let size = window;
  while (from <= toBlock) {
    const to = Math.min(toBlock, from + size - 1);
    let logs: RawLog[];
    try {
      logs = (await rpc("eth_getLogs", [{ address: RELAYER_REGISTRY, topics: [REGISTERED_TOPIC], fromBlock: hex(from), toBlock: hex(to) }])) as RawLog[];
    } catch (e) {
      if (size > 1_000) {
        size = Math.floor(size / 2);
        continue;
      }
      throw e;
    }
    for (const log of logs) if (!log.removed) out.push(decodeRegistered(log));
    from = to + 1;
  }
  return out.sort((a, b) => a.blockNumber - b.blockNumber);
}

/** The newest registration per ENS name. */
export function latestByName(registrations: readonly Registration[]): Registration[] {
  const map = new Map<string, Registration>();
  for (const r of registrations) map.set(r.ensName, r);
  return [...map.values()];
}

export interface RelayerRecord {
  ensName: string;
  relayerAddress: Hex;
  /** the ENS name's owner */
  owner: Hex;
  registered: boolean;
  balanceWei: bigint;
  /** the `url` text record of mainnet-tornado.<name>: a host, without a scheme, or "" */
  host: string;
}

async function callWord(rpc: Rpc, to: string, data: string): Promise<bigint> {
  const out = (await rpc("eth_call", [{ to, data }, "latest"])) as string;
  if (typeof out !== "string" || out.length !== 66) throw new Error("the call answered no word");
  return BigInt(out);
}
const addressOf = (w: bigint): Hex => `0x${w.toString(16).padStart(40, "0")}`;

/** The ENS owner and resolver, the host record, the registration and the stake of one relayer (five or six calls). */
export async function readRelayerRecord(rpc: Rpc, ensName: string, relayerAddress: Hex): Promise<RelayerRecord> {
  const node = namehash(ensName);
  const owner = addressOf(await callWord(rpc, ENS_REGISTRY, REGISTRY_SELECTORS.owner + node.slice(2)));
  const resolver = addressOf(await callWord(rpc, ENS_REGISTRY, REGISTRY_SELECTORS.resolver + node.slice(2)));
  let host = "";
  if (BigInt(resolver) !== 0n) {
    try {
      host = decodeString((await rpc("eth_call", [{ to: resolver, data: encodeText(namehash(`${SUBDOMAIN}.${ensName}`), "url") }, "latest"])) as string).trim();
    } catch {
      host = "";
    }
  }
  const [registered, balanceWei] = await Promise.all([
    callWord(rpc, RELAYER_REGISTRY, REGISTRY_SELECTORS.isRelayerRegistered + addressWord(owner) + addressWord(owner)).then((w) => w === 1n),
    callWord(rpc, RELAYER_REGISTRY, REGISTRY_SELECTORS.getRelayerBalance + addressWord(owner)),
  ]);
  return { ensName, relayerAddress: relayerAddress.toLowerCase() as Hex, owner, registered, balanceWei, host };
}

export type RegistryProblem = "no host record" | "host carries a scheme" | "owner is not the registered address" | "not registered" | "stake below the floor";

/** The original UI's rules over a record; empty when the relayer qualifies. */
export function registryProblems(r: RelayerRecord, { minStakeWei = MIN_STAKE_WEI } = {}): RegistryProblem[] {
  const problems: RegistryProblem[] = [];
  if (!r.host) problems.push("no host record");
  else if (/^[a-z]+:\/\//i.test(r.host)) problems.push("host carries a scheme");
  if (r.owner !== r.relayerAddress) problems.push("owner is not the registered address");
  if (!r.registered) problems.push("not registered");
  if (r.balanceWei < minStakeWei) problems.push("stake below the floor");
  return problems;
}

/** The registry's current minimum stake for a new registration. */
export const readMinStake = (rpc: Rpc): Promise<bigint> => callWord(rpc, RELAYER_REGISTRY, REGISTRY_SELECTORS.minStakeAmount);
