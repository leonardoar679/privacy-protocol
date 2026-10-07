import { useEffect, useState } from "react";
import qrcode from "qrcode-generator";
import { SWAP_SERVICE, type AssetRef, type QuoteSet } from "../sdk/swapService";
import { checkGuestInstruction, type CheckedGuest } from "../sdk/guestGuard";
import { MinimumMoved } from "../sdk/providerCall";

// Walletless mode (plan §49): no seed, no pool, no keys. The user says what they sell and where the
// result should go; the service returns a ONE-TIME deposit instruction (THORChain's walletless flow:
// the inbound vault address confirmed by an independent gateway quorum, a memo with the destination
// and a locally built minimum output). The user pays from any wallet and tracks by transaction id.
// The instruction is checked by this browser before it is shown (sdk/guestGuard.ts): the address must be
// the vault THORChain's public gateways report, the memo must pay the typed destination and enforce at
// least the quoted minimum; a lower minimum is shown and needs the guest's consent.
// Statuses are the plan's (§33): Pending / Executing / Completed / Partial / Refunding / Refunded / Failed.
const SOURCES: Record<string, AssetRef> = { BTC: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, LTC: { chain: "litecoin", asset: "native", decimals: 8, symbol: "LTC" }, DOGE: { chain: "doge", asset: "native", decimals: 8, symbol: "DOGE" } };
const TARGETS: Record<string, AssetRef> = { ETH: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" }, "USDC on Ethereum": { chain: "ethereum", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" } };
interface Instruction { provider: string; quote: { toAmount: string; toAmountMin: string; etaSeconds: number }; ingress: { to: string; memo?: string; amount: string; expiresAt: number; verified: string[] }; status: string }
const fmt = (units: string, decimals: number) => (Number(units) / 10 ** decimals).toFixed(Math.min(decimals, 6));

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(SWAP_SERVICE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `service error ${r.status}`);
  return j as T;
}

export function Guest({ onBack, freshDestination }: { onBack: () => void; freshDestination?: (chain: string) => string }) {
  const [source, setSource] = useState("BTC");
  const [target, setTarget] = useState("ETH");
  const [amount, setAmount] = useState("0.01");
  const [destination, setDestination] = useState(() => freshDestination?.("ethereum") ?? "");
  const [quotes, setQuotes] = useState<QuoteSet | null>(null);
  const [instruction, setInstruction] = useState<Instruction | null>(null);
  const [checked, setChecked] = useState<CheckedGuest | null>(null);
  const [moved, setMoved] = useState<MinimumMoved | null>(null);
  const [txid, setTxid] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const from = SOURCES[source], to = TARGETS[target];
  const units = () => BigInt(Math.round(Number(amount || "0") * 10 ** from.decimals)).toString();
  const request = () => ({ from, to, amount: units(), destination, slippageBps: 100, policy: "best-price" });

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label); setError("");
    try { return await fn(); } catch (e: any) { setError(e?.message ?? String(e)); } finally { setBusy(""); }
  }
  async function getQuote() {
    setInstruction(null); setChecked(null); setMoved(null); setStatus(null);
    const set = await run("Getting quotes…", () => post<QuoteSet>("/guest/quote", request()));
    if (set) setQuotes(set);
  }
  /** Fetch the deposit instruction and check it here before showing it; `acceptMin`: the guest consented to a lower minimum. */
  async function getInstruction(acceptMin?: bigint) {
    const approvedMin = acceptMin ?? BigInt(thor?.toAmountMin ?? "0");
    const res = await run("Preparing and checking your one-time deposit instruction…", async () => {
      const ins = await post<Instruction>("/guest/ingress", request());
      try {
        return { ins, checked: await checkGuestInstruction(ins, { from, to, destination, amount: BigInt(units()), approvedMin }) };
      } catch (e) {
        if (e instanceof MinimumMoved) return { moved: e };
        throw e;
      }
    });
    if (!res) return;
    if ("moved" in res) { setMoved(res.moved ?? null); return; }
    setMoved(null); setChecked(res.checked); setInstruction(res.ins);
  }
  useEffect(() => {
    if (!instruction || !txid.trim()) return;
    const tick = () => fetch(`${SWAP_SERVICE}/guest/track/${instruction.provider}/${encodeURIComponent(txid.trim())}`).then((r) => r.json()).then((j) => setStatus(j.status ?? "Pending")).catch(() => {});
    tick();
    const t = setInterval(tick, 20_000);
    return () => clearInterval(t);
  }, [instruction, txid]);

  const depositText = checked ? checked.depositAddress : "";
  const svg = instruction && checked ? (() => { const q = qrcode(0, "M"); q.addData(depositText); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); })() : "";
  // the instruction is always THORChain's (the route whose deposit address can be verified): show its numbers
  const thor = quotes?.quotes.find((q) => q.provider === "thorchain");

  return (
    <div className="panel" data-testid="guest">
      <h3>Swap without a wallet</h3>
      <p className="muted" style={{ fontSize: 13 }}>Send from any wallet to a one-time deposit address; the swap delivers to the address you choose. Nothing is stored and no account is created. This path is NOT private on the source side: the sending address is yours.</p>
      <label>Sell</label>
      <select value={source} onChange={(e: any) => { setSource(e.target.value); setQuotes(null); setInstruction(null); }}>
        {Object.keys(SOURCES).map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <label>Amount</label>
      <input value={amount} onChange={(e: any) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
      <label>Receive</label>
      <select value={target} onChange={(e: any) => { setTarget(e.target.value); setQuotes(null); setInstruction(null); }}>
        {Object.keys(TARGETS).map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <label>Destination address{freshDestination ? " (a fresh address of your wallet)" : ""}</label>
      <input value={destination} onChange={(e: any) => setDestination(e.target.value.trim())} placeholder="0x…" />
      <div className="tabs">
        <button className="primary" onClick={getQuote} disabled={!!busy || !destination}>Get a quote</button>
        <button className="tab" onClick={onBack}>Back</button>
      </div>
      {busy && <p className="muted">{busy}</p>}
      {error && <p style={{ color: "var(--warn)" }}>{error}</p>}
      {quotes && !instruction && (
        <div style={{ marginTop: 10 }}>
          {thor ? (
            <>
              <div className="row"><span className="muted">Receive approximately</span><b>{fmt(thor.toAmount, to.decimals)} {to.symbol}</b></div>
              <div className="row"><span className="muted">At least</span><b>{fmt(thor.toAmountMin, to.decimals)} {to.symbol}</b></div>
              <div className="row"><span className="muted">Estimated</span><b>~{Math.round(thor.etaSeconds / 60)} min</b></div>
              <button className="primary" onClick={() => getInstruction()} disabled={!!busy}>Show my deposit instruction</button>
              <p className="muted" style={{ fontSize: 12 }}>The instruction comes from THORChain, the native-chain route whose deposit address this browser verifies against independent gateways before showing it.</p>
            </>
          ) : <p className="muted">No verifiable deposit route right now{quotes.errors.thorchain ? ` (THORChain: ${quotes.errors.thorchain})` : ""}.</p>}
          {moved && (
            <div style={{ marginTop: 8, padding: 8, border: "1px solid var(--warn)", borderRadius: 6 }}>
              <p style={{ fontSize: 13, margin: 0 }}>The price moved. The deposit instruction now guarantees at least <b>{fmt(moved.minOut.toString(), to.decimals)} {to.symbol}</b>; the quote showed {fmt(moved.approved.toString(), to.decimals)} {to.symbol}. Nothing has been shown to pay yet.</p>
              <button className="tab" onClick={() => getInstruction(moved.minOut)} disabled={!!busy}>Show the instruction at the new minimum</button>
            </div>
          )}
        </div>
      )}
      {instruction && checked && (
        <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <div style={{ width: 180, height: 180, background: "#fff", padding: 6, borderRadius: 8 }} dangerouslySetInnerHTML={{ __html: svg }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="muted" style={{ fontSize: 12 }}>Send exactly</div>
              <b>{fmt(instruction.ingress.amount, from.decimals)} {from.symbol}</b>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>to this one-time address</div>
              <code style={{ fontSize: 12, wordBreak: "break-all", display: "block" }}>{checked.depositAddress}</code>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>with this memo (required: it names your destination and the minimum you accept)</div>
              <code style={{ fontSize: 11, wordBreak: "break-all", display: "block" }}>{checked.memo}</code>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>valid until {new Date(instruction.ingress.expiresAt * 1000).toLocaleString()}</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }} data-testid="guest-checked">Checked by this browser: the address is THORChain's current {from.symbol} vault ({checked.gateways} public gateways agree); the memo pays the address you typed and enforces at least {fmt(checked.minOut.toString(), to.decimals)} {to.symbol}. A refund goes back to the address you send from.</div>
            </div>
          </div>
          <label>Your transaction id, once sent</label>
          <input value={txid} onChange={(e: any) => setTxid(e.target.value)} placeholder="txid" />
          <p className="muted" style={{ fontSize: 12 }}>Status: <b>{status ?? instruction.status}</b>{txid ? " — refreshed every 20 s" : ""}. A swap is not atomic: it can end Partial or Refunded; this screen says which.</p>
        </div>
      )}
    </div>
  );
}
