// Per-chain consensus constants the light client pins (never taken from a beacon API at run time: an API
// that lies about the fork schedule could make a forged signature domain verify). Values as served
// identically by two independent beacon APIs (ChainSafe Lodestar, PublicNode) on 2026-10-07. A fork the
// build does not know is refused (fail closed): its signature domain and generalized indices are unknown.
import { allowHosts } from "@privacy-wallet/privacy-engine/transport/http";
import type { Hex } from "viem";

/** Light-client data formats this build verifies (the `version` of a beacon API response). */
export type LcFork = "electra" | "fulu" | "gloas";

export interface ForkInfo { name: string; version: Hex; epoch: number }
export interface BeaconChainSpec {
  name: string;
  /** the execution chain id this consensus chain carries */
  chainId: bigint;
  genesisTime: number;
  genesisValidatorsRoot: Hex;
  /** ascending by epoch */
  forks: ForkInfo[];
  /** public beacon APIs serving the light-client routes with CORS (default; VITE_BEACON_URLS overrides) */
  beaconApis: string[];
}

export const SECONDS_PER_SLOT = 12;
export const SLOTS_PER_EPOCH = 32;
export const EPOCHS_PER_SYNC_COMMITTEE_PERIOD = 256;
export const SYNC_COMMITTEE_SIZE = 512;
export const DOMAIN_SYNC_COMMITTEE: Hex = "0x07000000";
/** Ethereum's BLS ciphersuite (proof-of-possession scheme). */
export const BLS_DST = "BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_";

export const MAINNET: BeaconChainSpec = {
  name: "mainnet", chainId: 1n, genesisTime: 1606824023,
  genesisValidatorsRoot: "0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95",
  forks: [
    { name: "phase0", version: "0x00000000", epoch: 0 }, { name: "altair", version: "0x01000000", epoch: 74240 },
    { name: "bellatrix", version: "0x02000000", epoch: 144896 }, { name: "capella", version: "0x03000000", epoch: 194048 },
    { name: "deneb", version: "0x04000000", epoch: 269568 }, { name: "electra", version: "0x05000000", epoch: 364032 },
    { name: "fulu", version: "0x06000000", epoch: 411392 },
    // gloas (0x07000000) is not scheduled on mainnet yet: signatures from it fail until this build knows its epoch
  ],
  beaconApis: ["https://lodestar-mainnet.chainsafe.io", "https://ethereum-beacon-api.publicnode.com"],
};

export const SEPOLIA: BeaconChainSpec = {
  name: "sepolia", chainId: 11155111n, genesisTime: 1655733600,
  genesisValidatorsRoot: "0xd8ea171f3c94aea21ebc42a1ed61052acf3f9209c00e4efbaaddac09ed9b8078",
  forks: [
    { name: "phase0", version: "0x90000069", epoch: 0 }, { name: "altair", version: "0x90000070", epoch: 50 },
    { name: "bellatrix", version: "0x90000071", epoch: 100 }, { name: "capella", version: "0x90000072", epoch: 56832 },
    { name: "deneb", version: "0x90000073", epoch: 132608 }, { name: "electra", version: "0x90000074", epoch: 222464 },
    { name: "fulu", version: "0x90000075", epoch: 272640 }, { name: "gloas", version: "0x90000076", epoch: 353024 },
  ],
  beaconApis: ["https://lodestar-sepolia.chainsafe.io", "https://ethereum-sepolia-beacon-api.publicnode.com"],
};

export const specForChain = (chainId: bigint | number): BeaconChainSpec | null => [MAINNET, SEPOLIA].find((s) => s.chainId === BigInt(chainId)) ?? null;

export const epochAtSlot = (slot: number) => Math.floor(slot / SLOTS_PER_EPOCH);
export const periodAtSlot = (slot: number) => Math.floor(epochAtSlot(slot) / EPOCHS_PER_SYNC_COMMITTEE_PERIOD);
export const currentSlot = (spec: BeaconChainSpec, nowMs = Date.now()) => Math.floor((nowMs / 1000 - spec.genesisTime) / SECONDS_PER_SLOT);

/** The fork active at `epoch` (the last one whose epoch has been reached). */
export function forkAtEpoch(spec: BeaconChainSpec, epoch: number): ForkInfo {
  let f = spec.forks[0];
  for (const x of spec.forks) if (x.epoch <= epoch) f = x;
  return f;
}

/** Generalized indices of the light-client proofs, per data format (consensus-specs light-client/sync-protocol.md). */
export const GINDEX: Record<LcFork, { finalizedRoot: number; currentSyncCommittee: number; nextSyncCommittee: number; execution: number }> = {
  // execution: the ExecutionPayloadHeader in the block body (EXECUTION_PAYLOAD_GINDEX)
  electra: { finalizedRoot: 169, currentSyncCommittee: 86, nextSyncCommittee: 87, execution: 25 },
  fulu: { finalizedRoot: 169, currentSyncCommittee: 86, nextSyncCommittee: 87, execution: 25 },
  // execution: the bid's parent_block_hash in the block body (EXECUTION_BLOCK_HASH_GINDEX_GLOAS)
  gloas: { finalizedRoot: 735, currentSyncCommittee: 2945, nextSyncCommittee: 2946, execution: 2856 },
};

export function lcFork(version: string): LcFork {
  if (version === "electra" || version === "fulu" || version === "gloas") return version;
  throw new Error(`light client: data format "${version}" is not one this build verifies`);
}

// the public beacon APIs are endpoints of this deployment (Privacy Wallet Web spec §7)
allowHosts(...MAINNET.beaconApis, ...SEPOLIA.beaconApis);
