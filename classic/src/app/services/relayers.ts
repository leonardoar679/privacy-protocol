// The relayers the app offers (spec v3.0 §7.5; V7 Stage 9): the curated list, each asked for its status when the
// withdraw screen needs them — one or two at a time — and held to the rules for every pool; online, offline or unknown
// on the screen, the facts kept for the fee lines and the request.
import type { RelayerTransport } from "../../relayer/client";
import { statusOf } from "../../relayer/client";
import type { CuratedRelayer } from "../../relayer/curated";
import { checkRelayer, type RelayerFacts, type RelayerProblem } from "../../relayer/rules";
import type { RelayerInfo } from "../../model/types";

export interface RelayerEntry extends RelayerInfo {
  relayerAddress: string;
  facts: RelayerFacts | null;
  problems: RelayerProblem[] | null;
  checkedAt: number | null;
}

export interface RelayerDirectoryDeps {
  curated: readonly CuratedRelayer[];
  transport: RelayerTransport;
  netId: number;
  pools: readonly { address: string; amount: string }[];
  now?: () => number;
  onChange?: (list: RelayerInfo[]) => void;
  /** at most this many status requests in flight (a burst stalled the development workstation) */
  concurrency?: number;
}

export class RelayerDirectory {
  private entries: RelayerEntry[];
  private refreshing: Promise<RelayerInfo[]> | null = null;

  constructor(private readonly d: RelayerDirectoryDeps) {
    this.entries = d.curated.map((r) => ({
      id: r.ensName,
      name: r.ensName,
      url: r.url,
      feePercentE4: Math.round(r.feePercent * 10_000),
      status: "unknown",
      relayerAddress: r.relayerAddress,
      facts: null,
      problems: null,
      checkedAt: null,
    }));
  }

  list(): RelayerInfo[] {
    return this.entries.map(({ id, name, url, feePercentE4, status }) => ({ id, name, url, feePercentE4, status }));
  }

  entry(id: string): RelayerEntry | null {
    return this.entries.find((e) => e.id === id) ?? null;
  }

  /** Asks every relayer; online when its status passes the rules for every pool. */
  refresh(): Promise<RelayerInfo[]> {
    return (this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    }));
  }

  private async doRefresh(): Promise<RelayerInfo[]> {
    const limit = Math.max(1, this.d.concurrency ?? 2);
    let next = 0;
    const one = async (e: RelayerEntry) => {
      try {
        const status = await statusOf(this.d.transport, e.url);
        const verdicts = this.d.pools.map((pool) => checkRelayer({ status, netId: this.d.netId, pool, expectedRewardAccount: e.relayerAddress }));
        const problems = [...new Set(verdicts.flatMap((v) => (v.ok ? [] : v.problems)))];
        e.facts = verdicts[0]?.facts ?? null;
        e.feePercentE4 = e.facts?.feePercentE4 ?? e.feePercentE4;
        e.problems = problems.length ? problems : null;
        e.status = problems.length ? "offline" : "online";
      } catch {
        e.facts = null;
        e.problems = null;
        e.status = "offline";
      }
      e.checkedAt = (this.d.now ?? Date.now)();
    };
    await Promise.all(
      Array.from({ length: Math.min(limit, this.entries.length) }, async () => {
        for (;;) {
          const i = next++;
          if (i >= this.entries.length) return;
          await one(this.entries[i]);
          this.d.onChange?.(this.list());
        }
      }),
    );
    return this.list();
  }

  /** The cheapest online relayer, by fee then stake order of the curated list. */
  cheapestOnline(): RelayerEntry | null {
    return [...this.entries].filter((e) => e.status === "online").sort((a, b) => a.feePercentE4 - b.feePercentE4)[0] ?? null;
  }

  onlineCount(): number | null {
    return this.entries.some((e) => e.checkedAt !== null) ? this.entries.filter((e) => e.status === "online").length : null;
  }
}
