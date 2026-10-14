// ClassicPrivacyContracts (spec v2.0 §11.3; V5 spec §16; V6 Stage 14): the classic pools as the module sees them — an
// interface the screens and the service are built on, with the devnet mock behind it in this pass. The real contracts,
// the circuit port and the proving keys are a later pass (the owner's V5 decision): until then the mock answers with a
// stand-in commitment (not Pedersen) and every withdrawal waits on "proof generation arrives with the circuit port".
// No chain, no funds; the mock's state lives in memory for the session. Nothing here touches PrivacyCore.
import { leBigInt, type ClassicNote } from "@privacy-wallet/protocol/classic/note";
import type { ClassicDepositRecord, ClassicStatus } from "@privacy-wallet/sdk/wallet/classicRecord";

export type { ClassicDepositRecord, ClassicStatus };

export interface ClassicPoolStats {
  size: string;
  deposits: number;
  /** seconds since the pool's last root */
  rootAge: number;
}
export interface ClassicWithdrawal {
  poolId: string;
  recipient: string;
  relayer: string;
  fee: string;
  proof: string | null;
  root: string;
  nullifierHash: string;
  status: "proof-pending" | "ready";
}

export interface ClassicPool {
  id: string;
  currency: string;
  /** the fixed denomination, in the currency's units */
  denomination: string;
  netId: number;
  stats(): ClassicPoolStats;
  deposit(note: ClassicNote, now?: number): ClassicDepositRecord;
  prepareWithdrawal(note: ClassicNote, recipient: string, relayer: string): ClassicWithdrawal;
  status(ref: string): ClassicStatus;
  /** the commitment a note's deposit carries (the real pools: Pedersen; the mock: a stand-in) */
  commitmentOf(note: ClassicNote): string;
  /** the deposit carrying a commitment, from the pool's deposit events; null when the pool has none */
  depositOf(commitment: string): { leafIndex: number; txHash: string } | null;
  /** whether the nullifier of a note was spent (a withdrawal happened) */
  spent(note: ClassicNote): boolean;
  /** Advanced: the Merkle root, the root age, the default relayer, its fee, the proof status */
  advanced(): { root: string; rootAge: number; relayer: string; relayerFeeBps: number; proofStatus: string };
}

/** The pools of a deployment (the interface the service is built on). */
export interface ClassicPrivacyContracts {
  pools(): ClassicPool[];
  pool(id: string): ClassicPool | undefined;
}

/** No pools: what a production build has until the classic contracts, the circuit port and their review arrive (owner,
 *  V5) — the devnet mock never stands in outside a development build (docs/classic-privacy-review.md, C-1). */
export const noClassicContracts: ClassicPrivacyContracts = { pools: () => [], pool: () => undefined };

const hex32 = (x: bigint): string => "0x" + (x % (1n << 256n)).toString(16).padStart(64, "0");

class MockPool implements ClassicPool {
  private readonly deposits = new Map<string, ClassicDepositRecord>();
  private readonly spentNullifiers = new Set<string>();
  private count: number;
  constructor(
    readonly id: string,
    readonly currency: string,
    readonly denomination: string,
    readonly netId: number,
    private size: number,
    deposits: number,
    private readonly rootAgeSeconds: number,
  ) {
    this.count = deposits;
  }
  stats(): ClassicPoolStats {
    return { size: `${this.size} ${this.currency.toUpperCase()}`, deposits: this.count, rootAge: this.rootAgeSeconds };
  }
  commitmentOf(note: ClassicNote): string {
    return hex32(leBigInt(note.nullifier) * 7n + leBigInt(note.secret) * 13n + 1n); // a stand-in for the Pedersen commitment of the port
  }
  deposit(note: ClassicNote, now = Date.now()): ClassicDepositRecord {
    const commitment = this.commitmentOf(note);
    const rec: ClassicDepositRecord = {
      id: `classic:${this.id}:${this.count}`,
      poolId: this.id,
      currency: this.currency,
      amount: this.denomination,
      commitment,
      leafIndex: this.count,
      txHash: hex32(BigInt(now) * 31n + BigInt(this.count)),
      at: now,
      status: "ready",
    };
    this.count += 1;
    this.size += Number(this.denomination);
    this.deposits.set(commitment, rec);
    return rec;
  }
  depositOf(commitment: string): { leafIndex: number; txHash: string } | null {
    const d = this.deposits.get(commitment.toLowerCase());
    return d ? { leafIndex: d.leafIndex, txHash: d.txHash } : null;
  }
  spent(note: ClassicNote): boolean {
    return this.spentNullifiers.has(hex32(leBigInt(note.nullifier) * 17n));
  }
  prepareWithdrawal(note: ClassicNote, recipient: string, relayer: string): ClassicWithdrawal {
    return {
      poolId: this.id,
      recipient,
      relayer,
      fee: `${(Number(this.denomination) * 0.003).toFixed(4)} ${this.currency.toUpperCase()}`,
      proof: null,
      root: this.advanced().root,
      nullifierHash: hex32(leBigInt(note.nullifier) * 17n),
      status: "proof-pending",
    };
  }
  status(ref: string): ClassicStatus {
    return [...this.deposits.values()].some((d) => d.id === ref || d.txHash === ref) ? "ready" : "unavailable";
  }
  advanced() {
    return {
      root: hex32(BigInt(this.count) * 1_000_003n + 5n),
      rootAge: this.rootAgeSeconds,
      relayer: "relayer.devnet.local",
      relayerFeeBps: 30,
      proofStatus: "proof generation arrives with the circuit port",
    };
  }
  /** tests: a withdrawal that happened */
  markSpent(note: ClassicNote): void {
    this.spentNullifiers.add(hex32(leBigInt(note.nullifier) * 17n));
  }
  /** tests */
  known(note: ClassicNote): ClassicDepositRecord | undefined {
    return this.deposits.get(this.commitmentOf(note));
  }
}

export const DEVNET_NET_ID = 31337;
export function devnetPools(): MockPool[] {
  return [
    new MockPool("eth-0.1", "eth", "0.1", DEVNET_NET_ID, 1_482.3, 14_823, 95),
    new MockPool("eth-1", "eth", "1", DEVNET_NET_ID, 1_482, 1_027, 95),
    new MockPool("eth-10", "eth", "10", DEVNET_NET_ID, 2_130, 213, 240),
  ];
}

let shared: MockPool[] | null = null;
/** The devnet mock's contracts, shared for the session. */
export const devnetContracts: ClassicPrivacyContracts = {
  pools: () => (shared ??= devnetPools()),
  pool: (id) => (shared ??= devnetPools()).find((p) => p.id === id),
};
/** tests: a fresh mock */
export function resetClassicPools(): void {
  shared = null;
}
export type { MockPool };
