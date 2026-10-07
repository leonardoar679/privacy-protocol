import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { swapService, type AssetRef, type Policy, type QuoteSet, type ServiceHealth, type ServiceOrder } from "../sdk/swapService";
import { deriveOrderKey, deriveRefundNote, signExecutionDigest } from "../keys/swapKeys";
import { privateWithdrawal } from "../sdk/privateTx";
import type { Deployment } from "../sdk/chain";
import { relayerSwapExecute, relayerSwapStatus, swapJobStatus, type SwapJob } from "../sdk/relayer";
import { noteStore } from "../wallet/notes";
import { useSettings } from "../wallet/settings";

// Private swap (spec v1.1): quote every provider through the local service, pick by policy, commit an
// order whose source is a one-time escrow, FUND the escrow with a private withdrawal proved in this
// tab, and only then (spec §5/§8: quotes are short-lived, the delay budget is long) re-quote with the
// escrow as sender, sign the provider call with the one-time key and hand (params, signed execution,
// refund payload) to a relayer's swap executor, which deploys + executes for its tip and refunds to
// your pre-committed note after the window. If the signed quote expires before execution, sign again.
// The permanent address never touches a provider; the relayer cannot change anything it was given.
const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const TARGETS: Record<string, { ref: AssetRef; placeholder: string }> = {
  BTC: { ref: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, placeholder: "bc1q… (fresh)" },
  SOL: { ref: { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" }, placeholder: "fresh Solana address" },
  "USDC on Base": { ref: { chain: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" }, placeholder: "0x… (fresh)" },
  "ETH on Base": { ref: { chain: "base", asset: "native", decimals: 18, symbol: "ETH" }, placeholder: "0x… (fresh)" },
};
const fmt = (units: string, decimals: number) => (Number(units) / 10 ** decimals).toFixed(Math.min(decimals, 6));
const hours = (s: number) => (s >= 3600 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 60)} min`);
const OPEN_FOR_RESIGN = ["expired", "execute-failed"];

export function Swap({ masterSeed, deployment }: { masterSeed: Uint8Array; deployment: Deployment | null }) {
  const { submission } = useSettings();
  const [target, setTarget] = useState("BTC");
  const [amount, setAmount] = useState("0.5");
  const [destination, setDestination] = useState("");
  const [policy, setPolicy] = useState<Policy>("best-privacy");
  const [quotes, setQuotes] = useState<QuoteSet | null>(null);
  const [order, setOrder] = useState<ServiceOrder | null>(null);
  const [orderKey, setOrderKey] = useState<{ privateKey: Hex; address: Hex } | null>(null);
  const [refundNoteData, setRefundNoteData] = useState<Hex | null>(null);
  const [funded, setFunded] = useState<string | null>(null);
  const [signed, setSigned] = useState<string | null>(null);
  const [job, setJob] = useState<SwapJob | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const to = TARGETS[target];
  const request = () => ({ from: ETH, to: to.ref, amount: (BigInt(Math.round(Number(amount) * 1e6)) * 10n ** 12n).toString(), destination, slippageBps: 50, policy });

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label); setError("");
    try { return await fn(); } catch (e: any) { setError(e.message ?? String(e)); } finally { setBusy(""); }
  }

  // follow the executor's job while it is open
  useEffect(() => {
    if (!job || submission.kind !== "relayer" || ["completed", "refunded", "refund-failed"].includes(job.state)) return;
    const url = submission.url;
    const t = setInterval(() => relayerSwapStatus(url, job.id).then(setJob).catch(() => {}), 15_000);
    return () => clearInterval(t);
  }, [job, submission]);

  function reset() { setOrder(null); setOrderKey(null); setRefundNoteData(null); setFunded(null); setSigned(null); setJob(null); }

  async function getQuotes() {
    reset();
    const set = await run("Quoting all providers…", () => swapService.quote(request()));
    if (set) setQuotes(set);
  }

  async function commit(provider?: string) {
    // the signer must be fixed at commit time, before the service chooses the orderId, so a one-time
    // key is derived per attempt from a random attempt id (never reused: a new attempt, a new key)
    const attemptId = ("0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
    const key = deriveOrderKey(masterSeed, attemptId);
    const refund = deriveRefundNote(masterSeed, Number(attemptId.slice(2, 10)) >>> 0);
    const res = await run("Building the order…", () =>
      swapService.order({ ...request(), provider, orderSigner: key.address, refundOwnerCommitment: refund.ownerCommitment.toString(), refundNoteSecret: refund.noteSecret.toString(), refundNoteDataHash: refund.noteDataHash }));
    if (res) { reset(); setOrder(res.order); setOrderKey(key); setRefundNoteData(refund.noteData); }
  }

  async function fundEscrow() {
    if (!order) return;
    if (!deployment) { setError("No deployment configured (VITE_RPC_URL / VITE_CORE / VITE_ETH_VAULT)."); return; }
    const gross = BigInt(order.params.amount); // the withdrawal funds the whole order; the escrow pays the executor tip
    if (noteStore.balance(BigInt(deployment.ethVault)) < gross) { setError("Not enough shielded ETH in this session's notes for this order."); return; }
    const w = await run("Private withdrawal to the one-time escrow…", () => privateWithdrawal({ masterSeed, deployment, amount: gross, recipient: order.endpoint, onStatus: setBusy }));
    if (w) setFunded(`Escrow funded in tx ${w.txHash.slice(0, 10)}… (proof ${(w.proofMs / 1000).toFixed(1)} s${w.verifiedLocally ? ", verified locally" : ""}, submitted by ${w.submittedBy}${w.feeWei ? `, fee ${fmt(w.feeWei.toString(), 18)} ETH` : ""}).`);
  }

  /** Re-quote with the escrow as sender, sign the provider call locally, hand it to the executor. Repeatable while the job is open. */
  async function signAndHand() {
    if (!order || !orderKey || !refundNoteData) return;
    const r = await run("Re-quoting with the escrow as sender, then signing locally…", async () => {
      const prepared = await swapService.prepare(order.orderId);
      const signature = await signExecutionDigest(orderKey.privateKey, prepared.digest); // the key never leaves this tab
      const fin = await swapService.finalize(order.orderId, signature);
      const label = `${fin.execution.provider} · ${fmt(fin.execution.value, 18)} ETH · valid until ${new Date(fin.execution.deadline * 1000).toLocaleTimeString()} · sig ${fin.execution.signature.slice(0, 12)}…`;
      if (submission.kind !== "relayer") return { label, job: undefined };
      setBusy("Handing the signed order to the relayer's executor…");
      const health: ServiceHealth = await swapService.health();
      const j = await relayerSwapExecute(submission.url, { factory: health.deployment.factory, params: order.params, execution: fin.execution, refundNoteData });
      return { label, job: j };
    });
    if (r) { setSigned(r.label); if (r.job) setJob(r.job); }
  }

  return (
    <div className="panel">
      <h3>Swap privately</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        The pool pays a one-time escrow; a relayer executes the provider call you sign here; a failed swap returns to the pool as a fresh note.
      </p>
      <label>From</label>
      <input value={`${amount} ETH (private balance)`} onChange={(e: any) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
      <label>To</label>
      <select value={target} onChange={(e: any) => { setTarget(e.target.value); setQuotes(null); reset(); }}>
        {Object.keys(TARGETS).map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <label>Fresh destination address (never your public address)</label>
      <input value={destination} onChange={(e: any) => setDestination(e.target.value)} placeholder={to.placeholder} />
      <label>Policy</label>
      <select value={policy} onChange={(e: any) => setPolicy(e.target.value)}>
        <option value="best-privacy">Best privacy (6–72 h delay budget)</option>
        <option value="best-price">Best price (1–24 h)</option>
        <option value="fastest">Fastest (no delay; public submission)</option>
      </select>
      <button className="primary" onClick={getQuotes} disabled={!!busy || !destination}>Get quotes</button>
      {busy && <p className="muted">{busy}</p>}
      {error && <p style={{ color: "var(--warn)" }}>{error}</p>}

      {quotes && (
        <div style={{ marginTop: 14 }}>
          {quotes.scores.map((s) => {
            const q = quotes.quotes.find((x) => x.provider === s.provider)!;
            const chosen = quotes.chosen?.provider === s.provider;
            return (
              <div key={s.provider} className="row" style={{ padding: "6px 0", borderTop: "1px solid var(--border)", opacity: s.filtered ? 0.55 : 1 }}>
                <div>
                  <b>{s.provider}</b>{chosen && <span className="muted"> · chosen</span>}
                  <div className="muted" style={{ fontSize: 12 }}>
                    min {fmt(q.toAmountMin, to.ref.decimals)} {to.ref.symbol} · ~{hours(q.etaSeconds)} · {q.nativeAssets ? "native" : "wrapped leg"}
                    {q.refundTarget === "destination" ? " · refunds land at the destination" : ""}
                    {s.filtered ? ` · ${s.filtered}` : ""}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <b>{fmt(q.toAmount, to.ref.decimals)} {to.ref.symbol}</b>
                  <div className="muted" style={{ fontSize: 12 }}>score {s.total} · privacy {s.components.privacy} · security {s.components.security}</div>
                  {!s.filtered && <button className="tab" style={{ marginTop: 4 }} onClick={() => commit(s.provider)} disabled={!!busy}>Use</button>}
                </div>
              </div>
            );
          })}
          {Object.entries(quotes.errors).map(([p, e]) => (
            <div key={p} className="muted" style={{ fontSize: 12, padding: "4px 0" }}>{p}: {e}</div>
          ))}
        </div>
      )}

      {order && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <div className="row"><span className="muted">Route</span><b>{order.quote.provider}</b></div>
          <div className="row"><span className="muted">One-time escrow (withdrawal recipient)</span><code>{order.endpoint}</code></div>
          <div className="row"><span className="muted">Executor tip</span><b>{fmt(order.params.executorTip, 18)} ETH</b></div>
          <div className="row"><span className="muted">Delay budget</span><b>{hours(order.privacy.delaySeconds[0])} – {hours(order.privacy.delaySeconds[1])}</b></div>
          <div className="row"><span className="muted">Cross-chain privacy score</span><b>{order.privacy.score}</b></div>
          <div className="row"><span className="muted">Refund after</span><b>{new Date(order.params.refundAfter * 1000).toLocaleString()}</b></div>
          <div className="row"><span className="muted">Order key (one-time)</span><code>{orderKey?.address}</code></div>
          <div className="tabs" style={{ marginTop: 10 }}>
            <button className="primary" onClick={fundEscrow} disabled={!!busy || !!funded}>1 · Withdraw privately to the escrow</button>
            <button className="primary" onClick={signAndHand} disabled={!!busy || !funded || (!!job && !OPEN_FOR_RESIGN.includes(job.state))}>
              {job && OPEN_FOR_RESIGN.includes(job.state) ? "2 · Re-sign with a fresh quote" : submission.kind === "relayer" ? "2 · Sign provider call & hand to relayer" : "2 · Sign provider call"}
            </button>
          </div>
          {funded && <p className="muted" style={{ fontSize: 12 }}>{funded}</p>}
          {signed && <p className="muted" style={{ fontSize: 12 }}>Signed execution: {signed}{submission.kind !== "relayer" ? " — submit deployAndExecute yourself or switch to relayer submission." : ""}</p>}
          {job
            ? <p className="muted" style={{ fontSize: 12 }}>Status: <b>{swapJobStatus(job.state)}</b> ({job.state}{job.txHash ? `, tx ${job.txHash.slice(0, 10)}…` : ""}{job.error ? `, ${job.error}` : ""}) — refreshed every 15 s from the executor{OPEN_FOR_RESIGN.includes(job.state) ? "; the signed quote is no longer valid: re-sign with a fresh one" : ""}.</p>
            : <p className="muted" style={{ fontSize: 12 }}>Status: Pending — fund the escrow first (proved in this tab, submitted {submission.kind === "relayer" ? "by the relayer" : "through the connected wallet"}), then sign the provider call against a fresh quote.</p>}
        </div>
      )}
    </div>
  );
}
