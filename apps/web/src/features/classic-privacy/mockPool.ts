// The devnet mock of a classic pool (spec §16): three ETH pools with a size, a deposit count and a root age; a deposit
// returns a record at the next leaf; a withdrawal returns a placeholder labelled "proof generation arrives with the
// circuit port". No chain, no funds; the mock's state lives in memory for the session.
import { formatNote, leBigInt, type ClassicNote } from "@ref/classic/note";
import type { ClassicDepositRecord, ClassicPool, ClassicPoolStats, ClassicStatus, ClassicWithdrawal } from "./types";

const hex32 = (x: bigint): string => "0x" + (x % (1n << 256n)).toString(16).padStart(64, "0");

class MockPool implements ClassicPool {
  private readonly deposits = new Map<string, ClassicDepositRecord>();
  private count: number;
  constructor(readonly id: string, readonly currency: string, readonly denomination: string, readonly netId: number, private size: number, deposits: number, private readonly rootAgeSeconds: number) { this.count = deposits; }
  stats(): ClassicPoolStats { return { size: `${this.size} ${this.currency.toUpperCase()}`, deposits: this.count, rootAge: this.rootAgeSeconds }; }
  deposit(note: ClassicNote, now = Date.now()): ClassicDepositRecord {
    const commitment = hex32(leBigInt(note.nullifier) * 7n + leBigInt(note.secret) * 13n + 1n); // a stand-in for the Pedersen commitment of the port
    const rec: ClassicDepositRecord = { id: `classic:${this.id}:${this.count}`, poolId: this.id, currency: this.currency, amount: this.denomination, commitment, leafIndex: this.count, txHash: hex32(BigInt(now) * 31n + BigInt(this.count)), at: now, status: "ready" };
    this.count += 1; this.size += Number(this.denomination);
    this.deposits.set(formatNote(note), rec);
    return rec;
  }
  prepareWithdrawal(note: ClassicNote, recipient: string, relayer: string): ClassicWithdrawal {
    return { poolId: this.id, recipient, relayer, fee: `${(Number(this.denomination) * 0.003).toFixed(4)} ${this.currency.toUpperCase()}`, proof: null, root: this.advanced().root, nullifierHash: hex32(leBigInt(note.nullifier) * 17n), status: "proof-pending" };
  }
  status(ref: string): ClassicStatus { return [...this.deposits.values()].some((d) => d.id === ref || d.txHash === ref) ? "ready" : "unavailable"; }
  advanced() { return { root: hex32(BigInt(this.count) * 1_000_003n + 5n), rootAge: this.rootAgeSeconds, relayer: "relayer.devnet.local", relayerFeeBps: 30, proofStatus: "proof generation arrives with the circuit port" }; }
  /** tests */
  known(note: ClassicNote): ClassicDepositRecord | undefined { return this.deposits.get(formatNote(note)); }
}

export const DEVNET_NET_ID = 31337;
export function devnetPools(): ClassicPool[] {
  return [new MockPool("eth-0.1", "eth", "0.1", DEVNET_NET_ID, 1_482.3, 14_823, 95), new MockPool("eth-1", "eth", "1", DEVNET_NET_ID, 1_482, 1_027, 95), new MockPool("eth-10", "eth", "10", DEVNET_NET_ID, 2_130, 213, 240)];
}

let shared: ClassicPool[] | null = null;
export function classicPools(): ClassicPool[] { return (shared ??= devnetPools()); }
export function resetClassicPools(): void { shared = null; }
export const poolById = (id: string): ClassicPool | undefined => classicPools().find((p) => p.id === id);
