// The API's reads for reconcile and the quotes (spec v2.0 §15): the relayer's public job and terms (GET /swap/:orderId,
// GET /info — the terms cached 30 s), the escrow's balance and the chain's block over JSON-RPC, the provider's track through
// the engine's adapter. Server to server: the order id appears in the relayer's URL, never in the API's own.
import type { PrivateSwapEngine } from "@privacy-wallet/swap-engine/engine";
import type { ProviderId } from "@privacy-wallet/swap-engine/types";
import type { RelayerTerms } from "./quote";
import type { ReconcileReads, RelayerJobView } from "./reconcile";

type Fetch = typeof fetch;

async function rpc<T>(url: string, method: string, params: unknown[], f: Fetch): Promise<T> {
  const r = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: T; error?: { message?: string } };
  if (j.error || j.result === undefined) throw new Error(j.error?.message ?? `${method} failed`);
  return j.result;
}

/** balanceOf(address) */
const balanceOfCall = (owner: string) => `0x70a08231${owner.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;

export interface ReadsConfig {
  relayerUrl: string | null;
  rpcUrls: string[];
  engine: PrivateSwapEngine;
  fetch?: Fetch;
  now?: () => number;
}

export function makeReads(c: ReadsConfig): ReconcileReads & { relayerTerms(): Promise<RelayerTerms | null>; blockNumber(): Promise<number | null> } {
  const f = c.fetch ?? fetch;
  const now = c.now ?? Date.now;
  let terms: { at: number; value: RelayerTerms | null } | null = null;
  /** the first endpoint that answers */
  const firstAnswer = async <T>(method: string, params: unknown[]): Promise<T | null> => {
    for (const url of c.rpcUrls) {
      try {
        return await rpc<T>(url, method, params, f);
      } catch {
        /* the next endpoint */
      }
    }
    return null;
  };
  return {
    async job(orderId: string): Promise<RelayerJobView | "none" | null> {
      if (!c.relayerUrl) return "none";
      try {
        const r = await f(`${c.relayerUrl}/swap/${orderId.toLowerCase()}`);
        if (r.status === 404) return "none";
        if (!r.ok) return null;
        const j = (await r.json()) as RelayerJobView;
        return {
          state: j.state,
          ...(j.executionTx ? { executionTx: j.executionTx } : {}),
          ...(j.actualNetworkWei ? { actualNetworkWei: j.actualNetworkWei } : {}),
        };
      } catch {
        return null;
      }
    },
    async escrowBalance(escrow: string, asset: string): Promise<bigint | null> {
      const hex =
        asset === "native"
          ? await firstAnswer<string>("eth_getBalance", [escrow, "latest"])
          : await firstAnswer<string>("eth_call", [{ to: asset, data: balanceOfCall(escrow) }, "latest"]);
      return hex === null ? null : BigInt(hex === "0x" ? 0 : hex);
    },
    async track(provider: string, ref: { tx?: string; ref?: string }) {
      const adapter = c.engine.cfg.adapters.find((a) => a.id === (provider as ProviderId));
      if (!adapter) return null;
      const t = await adapter.track({ ...(ref.tx ? { sourceTxHash: ref.tx } : { providerRef: ref.ref }) });
      return { state: t.state, ...(t.destinationTxHash ? { destinationTxHash: t.destinationTxHash } : {}) };
    },
    async relayerTerms(): Promise<RelayerTerms | null> {
      if (!c.relayerUrl) return null;
      if (terms && now() - terms.at < 30_000) return terms.value;
      let value: RelayerTerms | null = null;
      try {
        const r = await f(`${c.relayerUrl}/info`);
        if (r.ok) {
          const j = (await r.json()) as RelayerTerms;
          value = { minFeeWei: String(j.minFeeWei), ...(j.feeVaults ? { feeVaults: j.feeVaults } : {}) };
        }
      } catch {
        value = null;
      }
      terms = { at: now(), value };
      return value;
    },
    async blockNumber(): Promise<number | null> {
      const hex = await firstAnswer<string>("eth_blockNumber", []);
      return hex === null ? null : Number(BigInt(hex));
    },
  };
}
