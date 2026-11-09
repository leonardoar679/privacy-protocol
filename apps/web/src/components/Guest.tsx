import { useEffect, useState } from "react";
import qrcode from "qrcode-generator";
import { api, ApiError, ApiTimeout } from "@privacy-wallet/sdk/api/client";
import type { AssetRef, QuoteSet } from "@privacy-wallet/sdk/swapService";
import { checkGuestInstruction, GuestDestinationHalted, GuestInstructionMismatch, type CheckedGuest } from "@privacy-wallet/sdk/guestGuard";
import { MinimumMoved, ProviderCallMismatch, ProviderCallUnverified } from "@privacy-wallet/sdk/providerCall";
import { TransportRefusal } from "@privacy-wallet/privacy-engine/transport/http";
import { fmtUnits, parseUnitsSafe } from "@privacy-wallet/sdk/format";
import { parseDestination } from "@privacy-wallet/protocol/wallet/destinations";
import { guestKnownRecipients } from "../features/recipients";
import { DestinationCard } from "./DestinationCard";

// Walletless mode (plan §49): no seed, no pool, no keys. The user says what they sell and where the
// result should go; the service returns a ONE-TIME deposit instruction (THORChain's walletless flow:
// the inbound vault address confirmed by an independent gateway quorum, a memo with the destination
// and a locally built minimum output). The user pays from any wallet and tracks by transaction id.
// The instruction is checked by this browser before it is shown (sdk/guestGuard.ts): the address must be
// the vault THORChain's public gateways report, the memo must pay the typed destination and enforce at
// least the quoted minimum; a lower minimum is shown and needs the guest's consent.
// Statuses are the plan's (§33): Pending / Executing / Completed / Partial / Refunding / Refunded / Failed.
const GUEST_KNOWN = guestKnownRecipients();
const SOURCES: Record<string, AssetRef> = { BTC: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, LTC: { chain: "litecoin", asset: "native", decimals: 8, symbol: "LTC" }, DOGE: { chain: "doge", asset: "native", decimals: 8, symbol: "DOGE" } };
const TARGETS: Record<string, AssetRef> = { ETH: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" }, "USDC on Ethereum": { chain: "ethereum", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" } };
interface Instruction { provider: string; quote: { toAmount: string; toAmountMin: string; etaSeconds: number }; ingress: { to: string; memo?: string; amount: string; expiresAt: number; verified: string[] }; status: string }
const fmt = (units: string, decimals: number) => fmtUnits(units, decimals); // from base units, never through a float
/** A track's status in the plan's words (§33); anything else the service answers reads as Pending. */
const STATUSES: readonly string[] = ["Pending", "Executing", "Completed", "Partial", "Refunding", "Refunded", "Failed"];
const statusOf = (s: unknown): string => (typeof s === "string" && STATUSES.includes(s) ? s : "Pending");
/**
 * What a refusal says here: this screen's own fixed words, never a message that carries a service's or a gateway's text (the eleventh review
 * round, 2026-11-04, E11-10). THORChain's quote error is the first THORNode gateway's to answer, and one answering with an `error` of its
 * choosing ("… send BTC to bc1q… instead") had been shown as "No verifiable deposit route right now (THORChain: …)"; the swap service's 502
 * carries the provider's words, and a refused instruction's own message repeats the service's memo, provider and vault — on the one screen
 * whose design is that nothing reaches a guest about to pay by hand before this browser has checked it against a quorum of gateways.
 */
const MISMATCH: Record<string, string> = {
  provider: "it is not THORChain's, the one route whose deposit address this browser can verify",
  source: "it is not for a coin this screen sells (BTC, LTC or DOGE)",
  amount: "it is for another amount than the one you typed",
  expiry: "it had already expired",
  vault: "the address it names is not one of THORChain's vaults as its public gateways list them",
  memo: "its memo is not one this browser can read and check",
  "memo asset": "its memo swaps into another asset than the one you chose",
  receiver: "its memo pays another address than the one you typed",
};
const CHAIN_NAME: Record<string, string> = { ETH: "Ethereum", BTC: "Bitcoin", LTC: "Litecoin", DOGE: "Dogecoin", BCH: "Bitcoin Cash" };
function refusalWords(e: unknown): string {
  if (e instanceof GuestInstructionMismatch) return `The deposit instruction does not match what you asked for${MISMATCH[e.field] ? `: ${MISMATCH[e.field]}` : ""}. It is not shown.`;
  if (e instanceof ProviderCallMismatch) return "THORChain's public gateways do not agree on its deposit details, so nothing is shown. Try again later.";
  // the chain the swap pays out on, halted (the twelfth review round, F12-5; ZE's critique: the gateways' sentence had named two other causes)
  if (e instanceof GuestDestinationHalted)
    return `THORChain has paused swaps into ${CHAIN_NAME[e.chain] ?? e.chain} right now: a swap sent now would come back to the address you send from, less its fee. Nothing is shown; try again later.`;
  if (e instanceof ProviderCallUnverified)
    return "THORChain's deposit address cannot be confirmed right now: too few of its public gateways agree, or it has paused deposits of this coin. Nothing is shown; try again in a moment.";
  if (e instanceof ApiTimeout) return "The swap service did not answer in time. Try again in a moment.";
  if (e instanceof ApiError)
    return e.code === "provider_unavailable"
      ? "THORChain gave no deposit instruction for this swap right now. Try again later, or with another amount."
      : e.code === "rate_limited"
        ? "Too many requests from this connection in a minute. Wait a moment, then try again."
        : e.code === "invalid_request"
          ? "The swap service could not take this request. Check the amount and the destination."
          : e.code === "amount_too_small"
            ? "This amount is too small for this swap. Try a larger amount." // never "try again in a moment" (the third critique of slice 4)
            : "The swap service could not answer this request right now. Try again in a moment.";
  if (e instanceof TransportRefusal) return "This browser refused a request to a host this screen does not use. Nothing was sent.";
  return "This could not be done right now. Check your connection and try again.";
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
  const units = () => parseUnitsSafe(amount, from.decimals).toString();
  // the typed destination is parsed for Ethereum (whale spec §21): a Bitcoin or Solana address is refused by name
  // ... never a token's own contract (the twelfth review round, F12-8: the swap screens refuse them; THORChain would pay USDC to the USDC contract)
  const parsedDest = destination ? parseDestination("evm", destination, GUEST_KNOWN) : null;
  const destError = parsedDest && !parsedDest.ok ? parsedDest.reason : "";
  const request = () => ({ from, to, amount: units(), destination, slippageBps: 100, policy: "best-price" });

  /** An input changed (audit round 2, r34): the quote and an instruction on screen were for the old one — they go. Before, an
   *  instruction for a destination since corrected stayed, saying "the memo pays the address you typed". */
  const edited = () => { setQuotes(null); setInstruction(null); setChecked(null); setMoved(null); setStatus(null); };

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label); setError("");
    try { return await fn(); } catch (e) { setError(refusalWords(e)); } finally { setBusy(""); }
  }
  async function getQuote() {
    setInstruction(null); setChecked(null); setMoved(null); setStatus(null);
    const set = await run("Getting quotes…", () => api.guestQuote<QuoteSet>(request()));
    if (set) setQuotes(set);
  }
  /** Fetch the deposit instruction and check it here before showing it; `acceptMin`: the guest consented to a lower minimum. */
  async function getInstruction(acceptMin?: bigint) {
    const approvedMin = acceptMin ?? BigInt(thor?.toAmountMin ?? "0");
    const res = await run("Preparing and checking your one-time deposit instruction…", async () => {
      const ins = await api.guestIngress<Instruction>(request());
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
    const tick = () => api.guestTrack<{ status?: string }>(instruction.provider, txid.trim()).then((j) => setStatus(statusOf(j.status))).catch(() => {});
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
      <select value={source} onChange={(e: any) => { setSource(e.target.value); edited(); }}>
        {Object.keys(SOURCES).map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <label>Amount</label>
      <input value={amount} onChange={(e: any) => { setAmount(e.target.value.replace(/[^0-9.]/g, "")); edited(); }} />
      <label>Receive</label>
      <select value={target} onChange={(e: any) => { setTarget(e.target.value); edited(); }}>
        {Object.keys(TARGETS).map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <label>Destination address{freshDestination ? " (a fresh address of your wallet)" : ""}</label>
      <input value={destination} onChange={(e: any) => { setDestination(e.target.value.trim()); edited(); }} placeholder="0x…" />
      {destError && <p className="error" style={{ fontSize: 13, marginTop: -4 }} data-testid="destination-error">Destination: {destError}.</p>}
      <div className="tabs">
        <button className="primary" onClick={getQuote} disabled={!!busy || !destination || !!destError}>Get a quote</button>
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
              <DestinationCard network="Ethereum" asset={to.symbol} address={destination} amount={`at least ${fmt(thor.toAmountMin, to.decimals)}`} kind="entered" title="Receive at" />
              <button className="primary" onClick={() => getInstruction()} disabled={!!busy || !!destError}>Show my deposit instruction</button>
              <p className="muted" style={{ fontSize: 12 }}>The instruction comes from THORChain, the native-chain route whose deposit address this browser verifies against independent gateways before showing it.</p>
            </>
          ) : <p className="muted" data-testid="guest-no-route">{quotes.errors.thorchain ? "No verifiable deposit route right now: THORChain gave no quote for this swap. Try again later, or with another amount." : "No verifiable deposit route right now."}</p>}
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
          <p className="muted" style={{ fontSize: 12 }}>Status: <b>{status ?? statusOf(instruction.status)}</b>{txid ? " — refreshed every 20 s" : ""}. A swap is not atomic: it can end Partial or Refunded; this screen says which.</p>
        </div>
      )}
    </div>
  );
}
