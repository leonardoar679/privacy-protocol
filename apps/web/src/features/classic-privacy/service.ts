// ClassicPrivacyService (spec v2.0 §11.3; V5 spec §16; V6 Stage 14): what the classic screens do, over the contracts
// interface (./contracts.ts) and the relayer choice (./relayer.ts), with its own state in the journal's optional
// `classic` field — never the protected balance's notes, never PrivacyCore. A deposit is journaled with its commitment;
// a pasted note is recovered (its pool, its deposit on chain, whether it was withdrawn, whether this wallet journaled it);
// a withdrawal is prepared against a note, a recipient and a chosen relayer; a pool's status says how fresh its root is.
import { parseNote, validateNote, type ClassicNote } from "@privacy-wallet/protocol/classic/note";
import type { ClassicDepositRecord, ClassicPool, ClassicPrivacyContracts, ClassicWithdrawal } from "./contracts";
import type { ClassicRelayerChoice } from "./relayer";

/** Where the module keeps its deposits (the journal's `classic` field, behind the session in the app; in memory in tests). */
export interface ClassicJournal {
  deposits(): ClassicDepositRecord[];
  put(rec: ClassicDepositRecord): void;
}

/** A root older than this reads as stale: a withdrawal would prove against an old root and may wait for a fresh one. */
export const STALE_ROOT_SECONDS = 3600;

export type RecoverResult =
  | { ok: false; reason: "malformed" | "unknown-pool"; detail: string }
  | {
      ok: true;
      note: ClassicNote;
      pool: ClassicPool;
      commitment: string;
      /** the deposit on chain, if the pool has one with this commitment */
      onChain: { leafIndex: number; txHash: string } | null;
      /** this wallet journaled the deposit */
      journaled: boolean;
      status: "ready" | "withdrawn" | "not-found";
    };

export type PrepareResult =
  | { ok: true; withdrawal: ClassicWithdrawal }
  | { ok: false; reason: "malformed" | "unknown-pool" | "wrong-pool" | "bad-recipient" | "not-found" | "withdrawn" | "no-relayer"; detail: string };

export interface PoolStatus {
  id: string;
  size: string;
  deposits: number;
  rootAge: number;
  health: "ready" | "stale";
  relayer: string;
  relayerFeePercent: number;
  mine: number;
}

export class ClassicPrivacyService {
  constructor(
    readonly contracts: ClassicPrivacyContracts,
    readonly journal: ClassicJournal,
    readonly relayers: () => readonly ClassicRelayerChoice[],
  ) {}

  pools(): ClassicPool[] {
    return this.contracts.pools();
  }

  /** The deposits this wallet made into a pool and has not seen withdrawn. */
  mine(poolId: string): ClassicDepositRecord[] {
    return this.journal.deposits().filter((d) => d.poolId === poolId && d.status !== "withdrawn");
  }

  poolStatus(poolId: string): PoolStatus | null {
    const pool = this.contracts.pool(poolId);
    if (!pool) return null;
    const st = pool.stats();
    const adv = pool.advanced();
    return {
      id: pool.id,
      size: st.size,
      deposits: st.deposits,
      rootAge: st.rootAge,
      health: st.rootAge > STALE_ROOT_SECONDS ? "stale" : "ready",
      relayer: adv.relayer,
      relayerFeePercent: adv.relayerFeeBps / 100,
      mine: this.mine(pool.id).length,
    };
  }

  /** A deposit of a note generated for the pool, journaled with its commitment. */
  deposit(poolId: string, note: ClassicNote, now = Date.now()): ClassicDepositRecord {
    const pool = this.contracts.pool(poolId);
    if (!pool) throw new Error(`no classic pool ${poolId}`);
    const bad = validateNote(note, { currency: pool.currency, amount: pool.denomination, netId: pool.netId });
    if (bad) throw new Error(bad);
    const rec = pool.deposit(note, now);
    this.journal.put(rec);
    return rec;
  }

  /** A pasted note: its pool (by currency, amount and network), its deposit on chain, whether it was withdrawn. */
  recover(noteText: string): RecoverResult {
    const parsed = parseNote(noteText.trim());
    if (!parsed.ok) return { ok: false, reason: "malformed", detail: parsed.reason };
    const note = parsed.note;
    const pool = this.contracts.pools().find((p) => !validateNote(note, { currency: p.currency, amount: p.denomination, netId: p.netId }));
    if (!pool) return { ok: false, reason: "unknown-pool", detail: `no pool of ${note.amount} ${note.currency.toUpperCase()} on network ${note.netId}` };
    const commitment = pool.commitmentOf(note);
    const onChain = pool.depositOf(commitment);
    const journaled = this.journal.deposits().some((d) => d.commitment.toLowerCase() === commitment.toLowerCase());
    const status = !onChain ? "not-found" : pool.spent(note) ? "withdrawn" : "ready";
    return { ok: true, note, pool, commitment, onChain, journaled, status };
  }

  /** A withdrawal prepared for a note, a recipient and a relayer the user chose (the proof waits for the circuit port);
   *  on a pool's own screen (`poolId`) a note of another pool is refused with the reason. */
  prepareWithdrawal(noteText: string, recipient: string, relayerId: string, poolId?: string): PrepareResult {
    if (poolId) {
      const pool = this.contracts.pool(poolId);
      const parsed = parseNote(noteText.trim());
      if (pool && parsed.ok) {
        const bad = validateNote(parsed.note, { currency: pool.currency, amount: pool.denomination, netId: pool.netId });
        if (bad) return { ok: false, reason: "wrong-pool", detail: bad };
      }
    }
    const r = this.recover(noteText);
    if (!r.ok) return r;
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient.trim())) return { ok: false, reason: "bad-recipient", detail: "the recipient must be a 0x address" };
    if (r.status === "not-found") return { ok: false, reason: "not-found", detail: "the pool has no deposit for this note" };
    if (r.status === "withdrawn") return { ok: false, reason: "withdrawn", detail: "this note was already withdrawn" };
    const relayer = this.relayers().find((x) => x.id === relayerId);
    if (!relayer || relayer.status !== "online") return { ok: false, reason: "no-relayer", detail: "choose a relayer that is online" };
    return { ok: true, withdrawal: r.pool.prepareWithdrawal(r.note, recipient.trim(), relayer.name) };
  }
}
