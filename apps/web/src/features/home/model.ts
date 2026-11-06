// Home's view-model from the engine (spec v2.0 §7.1): the protected balance and the assets from the unspent notes, USD
// from the agreed feed prices in integer cents, the protection level from the privacy posture; and from Activity's own
// rows (../activity/rows.ts, the Simple experience) the operations in flight — one card each, newest first: an open
// record that has not failed (a failure before anything moved never raises one: an old failure never blocks Home), or
// a swap's or a protected execution's line still running — and the three newest movements, each with the title, the
// amount, the value and the status Activity shows. Pure: the route (../wallet/Home.tsx) reads the stores and passes them.
import type { PriceState } from "@privacy-wallet/sdk/prices";
import { availablePrice } from "@privacy-wallet/protocol/wallet/valuation";
import { diagnose } from "@privacy-wallet/sdk/operations/recovery";
import { isDraft, isOpen } from "@privacy-wallet/sdk/wallet/operationRecord";
import { fundedOf, type StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import type { MessageKey } from "../../app/i18n/en";
import type { Vars } from "../../app/i18n/messages";
import { formatDateTime } from "../../app/i18n/intl";
import { activityStatus, amountOf, centsOf, statusOf } from "../amounts";
import type { Amount, Status } from "../viewKit";
import type { ActivityRow } from "../activity/rows";
import { rowView } from "../activity/model";
import type { HomeModel, HomeOperation, ProtectionLevel } from "./View";
import { protectionLevelOf } from "../protectionLevel";

type T = (key: MessageKey, vars?: Vars) => string;

export interface HomeInputs {
  /** the deployment's assets (sdk/assets assetsOf) */
  assets: { symbol: string; decimals: number; vault: string }[];
  notes: { note: { vaultId: bigint; amount: bigint }; spent: boolean }[];
  prices: PriceState;
  /** the privacy posture's overall level (V4 words) */
  overall: "Excellent" | "Good" | "Reduced" | null;
  /** Activity's rows in the Simple experience, newest first (../activity/rows.ts buildRows) */
  rows: ActivityRow[];
  /** the Advanced experience's technical lines, null in Simple */
  advanced: string[] | null;
  returning?: string | null;
  /** the clock an order's drawn funding time is read against (ms since the epoch; the render's by default) */
  now?: number;
}

const ASSET_NAME: Record<string, string> = {
  ETH: "Ethereum",
  USDC: "USD Coin",
  USDT: "Tether USD",
  WETH: "Wrapped Ether",
  DAI: "Dai",
  BTC: "Bitcoin",
  SOL: "Solana",
};

/** The kinds whose line alone (an order or a protected execution without an operation record) can be in flight. */
const LINE_KINDS = new Set(["swap", "cross-chain", "campaign"]);

/** A row's state while it is in flight (a card on Home), else null. */
function inFlight(r: ActivityRow): HomeOperation["status"] | null {
  const s: Status | null = r.record
    ? isOpen(r.record.state) && !isDraft(r.record.state)
      ? statusOf(r.record)
      : null
    : r.activity && LINE_KINDS.has(r.kind) && !r.finished
      ? activityStatus(r.kind, r.activity.status)
      : null;
  return s === "executing" || s === "action-needed" || s === "preparing" ? s : null;
}

/**
 * The drawn funding time of an order delayed for more privacy and not funded yet, else null (the eleventh review round, 2026-11-04, E11-9):
 * it funds only while the wallet is unlocked, inside its window, so Home calls it scheduled — never executing — and says when.
 */
export const scheduledFundingOf = (s: StoredSwap | undefined, now: number): number | null => {
  const at = s?.runner?.delayUntil;
  return s && at !== undefined && at > now && !s.paused && !s.fundingAttempt && !fundedOf(s) ? at : null;
};

export function homeModel(i: HomeInputs, t: T): HomeModel {
  const now = i.now ?? Date.now();
  const prices = i.prices.status === "ready" ? i.prices.prices : null;
  const usd = (a: Amount): bigint | null => {
    const p = availablePrice(prices, a.symbol);
    return p ? centsOf(a.units, a.decimals, p.usd1e8) : null;
  };
  const unspent = i.notes.filter((n) => !n.spent);
  const assets = i.assets
    .map((a) => ({ a, units: unspent.filter((n) => n.note.vaultId === BigInt(a.vault)).reduce((s, n) => s + n.note.amount, 0n) }))
    .filter((x) => x.units > 0n)
    .map(({ a, units }) => {
      const amount = amountOf(units, a.symbol, a.decimals);
      return { amount, name: ASSET_NAME[a.symbol] ?? a.symbol, usdCents: usd(amount) };
    });
  const priced = assets.every((x) => x.usdCents !== null);
  const balance: HomeModel["balance"] = !assets.length
    ? { usdCents: 0n, state: "valued" }
    : i.prices.status === "loading"
      ? { usdCents: null, state: "loading" }
      : priced
        ? { usdCents: assets.reduce((s, x) => s + (x.usdCents ?? 0n), 0n), state: "valued" }
        : { usdCents: null, state: "unavailable" };
  const operations: HomeOperation[] = i.rows.flatMap((r) => {
    const status = inFlight(r);
    if (!status) return [];
    const v = rowView(r, t);
    // an order delayed for more privacy and not funded yet is scheduled, with its time (the eleventh review round, 2026-11-04, E11-9)
    const scheduled = scheduledFundingOf(r.swap, now);
    // "Your funds are safe." only when the record's funds class allows it (spec §12.4); a line alone is still checked
    return [
      {
        id: v.id,
        title: v.title,
        amount: v.amount,
        usdCents: v.usdCents,
        status,
        fundsSafe: r.record ? diagnose(r.record).fundsClass !== "unknown" : false,
        ...(scheduled !== null ? { scheduled: formatDateTime(scheduled) } : {}),
      },
    ];
  });
  const recent = i.rows
    .filter((r) => r.activity && r.kind !== "housekeeping")
    .slice(0, 3)
    .map((r) => rowView(r, t));
  // the Privacy Center's rule (the eleventh review round, 2026-11-04, E11-11): Home had read one level more — "Medium protection" for a posture
  // the Center it opens calls "Low", "Protected" for its "Medium"; a posture not known claims nothing
  const protection: ProtectionLevel = protectionLevelOf(i.overall) ?? "low";
  return { protection, balance, assets, operations, recent, returning: i.returning ?? null, advanced: i.advanced };
}
