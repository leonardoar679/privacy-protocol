import { useCallback, useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { feeSummary, swapService, type AssetRef, type Policy, type QuoteSet, type RouteScore, type ServiceHealth, type ServiceOrder } from "../sdk/swapService";
import { deriveOrderKey, deriveRefundNote, signExecutionDigest } from "../keys/swapKeys";
import { checkOrder, OrderMismatch, predictEscrow } from "../sdk/swapGuard";
import type { CheckedCall, MinimumMoved } from "../sdk/providerCall";
import { checkBeforeSigning, type JournaledOrder } from "../sdk/swapSign";
import { chainKindOf, consumeFreshAddress, peekFreshAddress } from "../keys/chainKeys";
import { privateWithdrawal, recoverSwapRefunds } from "../sdk/privateTx";
import type { Deployment } from "../sdk/chain";
import { assetByVault, assetsOf, bucketBelowFor, formatAmount, isBucketFor, parseAmount, type Asset } from "../sdk/assets";
import { relayerSwapExecute, relayerSwapRefund, relayerSwapStatus, swapJobStatus, type SwapJob } from "../sdk/relayer";
import { noteStore } from "../wallet/notes";
import { useSettings } from "../wallet/settings";
import { session, useSession } from "../wallet/session";
import type { StoredSwap } from "../wallet/journal";
import { completeAction, sampleDueAt, scheduleAction, useScheduler } from "../wallet/schedule";
import { AssetSelect } from "./AssetSelect";
import { Scorecard } from "./Scorecard";

// Private swap (spec v1.1, plan §22, §26–§31, §36, §47, §79): quote every provider through the local
// service, show ONE route in plain words (providers behind "View route"), commit an order whose source
// is a one-time escrow and whose destination is a fresh address of this wallet, FUND the escrow with a
// private withdrawal (ETH or an ERC-20 from its own vault) at a random time inside the policy's delay
// window (the order and its schedule live in the encrypted journal, so this survives a reload), then
// re-quote with the escrow as sender, sign the provider call with the one-time key and hand it to a
// relayer's executor, which deploys + executes for its tip and refunds to the pre-committed note after
// the window. If the signed quote expires before execution, sign again. The permanent address never
// touches a provider. Before the order key signs, the wallet reads the provider call itself
// (sdk/providerCall.ts): pinned contract, your fresh address as receiver, refunds to the escrow, and a
// minimum no lower than the one you approved — a lower one needs your fresh consent.
const TARGETS: Record<string, { ref: AssetRef; network: string }> = {
  BTC: { ref: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, network: "Bitcoin" },
  SOL: { ref: { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" }, network: "Solana" },
  "USDC on Base": { ref: { chain: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" }, network: "Base" },
  "ETH on Base": { ref: { chain: "base", asset: "native", decimals: 18, symbol: "ETH" }, network: "Base" },
};
const fmt = (units: string, decimals: number) => (Number(units) / 10 ** decimals).toFixed(Math.min(decimals, 6));
const hours = (s: number) => (s >= 3600 ? `${Math.round(s / 3600)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);
const OPEN_FOR_RESIGN = ["expired", "execute-failed", "refund-only"];
/** A funded order can still be returned unexecuted while no execution is running or settled. */
const CAN_RETURN = (job: SwapJob | null) => !job || ["waiting-funding", "expired", "execute-failed"].includes(job.state);
const risk = (security: number) => (security >= 85 ? "Low" : security >= 70 ? "Medium" : "High");
const settlement = (p: string) => (p === "thorchain" || p === "chainflip" ? "native deposit address" : p === "near-intents" ? "solver network" : p === "mayan" ? "signed intent (drivers compete)" : "aggregator / bridge");
const providerKind = (p: string): "deposit-address" | "signed-intent" | "aggregator-api" => (p === "thorchain" || p === "chainflip" || p === "near-intents" ? "deposit-address" : p === "mayan" ? "signed-intent" : "aggregator-api");
const DELAY_WINDOW: Record<Policy, [number, number]> = { "best-privacy": [6 * 3600, 72 * 3600], "best-price": [3600, 24 * 3600], fastest: [0, 0] };
const refOf = (a: Asset): AssetRef => ({ chain: "ethereum", asset: a.token ?? "native", decimals: a.decimals, symbol: a.symbol });

export function Swap({ masterSeed, deployment }: { masterSeed: Uint8Array; deployment: Deployment | null }) {
  const { submission, advanced } = useSettings();
  useSession(); // re-render when the journal-backed session changes
  const assets = assetsOf(deployment);
  const [fromAsset, setFromAsset] = useState(assets[0]);
  const [target, setTarget] = useState("BTC");
  const [amount, setAmount] = useState("0.5");
  const [destination, setDestination] = useState(() => peekFreshAddress(masterSeed, "bitcoin").address);
  const [destinationEdited, setDestinationEdited] = useState(false);
  const [policy, setPolicy] = useState<Policy>("best-privacy");
  const [quotes, setQuotes] = useState<QuoteSet | null>(null);
  const [showRoute, setShowRoute] = useState(false);
  const [order, setOrder] = useState<ServiceOrder | null>(null);
  const [stored, setStored] = useState<StoredSwap | null>(null);
  const [orderKey, setOrderKey] = useState<{ privateKey: Hex; address: Hex } | null>(null);
  const [refundNoteData, setRefundNoteData] = useState<Hex | null>(null);
  const [signed, setSigned] = useState<string | null>(null);
  const [checked, setChecked] = useState<CheckedCall | null>(null);
  const [moved, setMoved] = useState<MinimumMoved | null>(null);
  const [job, setJob] = useState<SwapJob | null>(null);
  const [refundLine, setRefundLine] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const to = TARGETS[target];
  const units = parseAmount(fromAsset, amount);
  const bucket = bucketBelowFor(fromAsset, units);
  const request = () => ({ from: refOf(fromAsset), to: to.ref, amount: units.toString(), destination, slippageBps: 50, policy });
  const openSwaps = session.isUnlocked() ? session.journal().swaps.filter((s) => !["completed", "refunded", "abandoned"].includes(s.state)) : [];
  /** The private asset a stored order was funded from (by the request's source asset). */
  const assetOfStored = (s: StoredSwap): Asset => { const src = String((s.request as any)?.from?.asset ?? "native"); return assets.find((a) => (a.token ?? "native").toLowerCase() === src.toLowerCase()) ?? assets[0]; };

  function chooseTarget(t: string) {
    setTarget(t); setQuotes(null); reset();
    if (!destinationEdited) setDestination(peekFreshAddress(masterSeed, chainKindOf(TARGETS[t].ref.chain)).address);
  }

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label); setError("");
    try { return await fn(); } catch (e: any) { setError(e.message ?? String(e)); } finally { setBusy(""); }
  }

  // follow the executor's job while it is open
  useEffect(() => {
    if (!job || submission.kind !== "relayer" || ["completed", "refunded", "refund-failed"].includes(job.state)) return;
    const url = submission.url;
    const t = setInterval(() => relayerSwapStatus(url, job.id).then((j) => { setJob(j); patchStored(job.id, { state: j.state }); }).catch(() => {}), 15_000);
    return () => clearInterval(t);
  }, [job, submission]);

  // the executor re-shielded the order: its refund note goes into the wallet now, not at the next rescan (PP-S09)
  useEffect(() => {
    if (job?.state !== "refunded" || !deployment || !stored) return;
    let live = true;
    const orderId = stored.orderId.toLowerCase();
    recoverSwapRefunds({ masterSeed, deployment })
      .then((rs) => {
        if (!live) return;
        const mine = rs.filter((r) => r.orderId.toLowerCase() === orderId);
        const amount = (r: (typeof rs)[number]) => { const a = assetByVault(deployment, r.note.vaultId); return a ? `${formatAmount(a, r.note.amount)} ${a.symbol}` : `${r.note.amount} base units`; };
        setRefundLine(mine.length ? `Refunded: ${mine.map(amount).join(" + ")} back in your private balance.` : "Refunded on chain; the refund is not in the pool view yet. Rescan under Private balance shortly.");
      })
      .catch((e) => live && setRefundLine(`Refunded on chain; recording the note failed (${e?.message ?? e}). Rescan under Private balance.`));
    return () => { live = false; };
  }, [job?.state, stored?.orderId, deployment]);

  function reset() { setOrder(null); setStored(null); setOrderKey(null); setRefundNoteData(null); setSigned(null); setChecked(null); setMoved(null); setJob(null); setShowRoute(false); setRefundLine(""); }
  function patchStored(orderId: string, patch: Partial<StoredSwap>) {
    session.update((j) => { const s = j.swaps.find((x) => x.orderId.toLowerCase() === orderId.toLowerCase()); if (s) Object.assign(s, patch); });
    setStored((s) => (s && s.orderId.toLowerCase() === orderId.toLowerCase() ? { ...s, ...patch } : s));
  }

  async function getQuotes() {
    reset();
    const set = await run("Finding the best route…", () => swapService.quote(request()));
    if (set) setQuotes(set);
  }

  /** The factory every escrow is recomputed from: the wallet's own configuration, never the service's word. */
  function swapFactory(): Address {
    if (!deployment?.swapFactory) throw new Error("No escrow factory configured (VITE_SWAP_FACTORY): this wallet cannot check the escrow address a swap service returns, so it does not commit or fund swap orders.");
    return deployment.swapFactory;
  }

  async function commit(provider?: string) {
    // the signer must be fixed at commit time, before the service chooses the orderId, so a one-time
    // key is derived per attempt from a random attempt id (never reused: a new attempt, a new key)
    let factory: Address;
    try { factory = swapFactory(); } catch (e: any) { setError(e.message); return; }
    const attemptId = ("0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
    const key = deriveOrderKey(masterSeed, attemptId);
    const refundCounter = noteStore.allocateCounter();
    const refund = deriveRefundNote(masterSeed, refundCounter);
    const shown = quotes?.quotes.find((q) => q.provider === (provider ?? quotes.chosen?.provider)); // the minimum the user saw and approved
    const dest = destinationEdited ? destination : consumeFreshAddress(masterSeed, chainKindOf(to.ref.chain)).address; // reserve the fresh address now
    const req = { ...request(), destination: dest };
    const res = await run("Committing the order…", async () => {
      const r = await swapService.order({ ...req, provider, orderSigner: key.address, refundOwnerCommitment: refund.ownerCommitment.toString(), refundNoteSecret: refund.noteSecret.toString(), refundNoteDataHash: refund.noteDataHash });
      // the escrow is recomputed here from OUR factory and the params; every field we chose is checked
      checkOrder(r.order, { factory, orderSigner: key.address as Address, refund, amount: BigInt(req.amount), asset: fromAsset });
      return r;
    });
    if (!res) return;
    reset();
    const dueAt = policy === "fastest" ? undefined : sampleDueAt(DELAY_WINDOW[policy]);
    const entry: StoredSwap = {
      orderId: res.order.orderId, attemptId, refundCounter, provider: res.order.quote.provider, policy, request: { from: req.from, to: req.to, amount: req.amount, destination: req.destination, slippageBps: req.slippageBps },
      params: res.order.params, endpoint: res.order.endpoint, quote: res.order.quote, approvedMin: (shown ?? res.order.quote).toAmountMin, createdAt: Date.now(), dueAt, state: "committed", refundNoteData: refund.noteData, // the random payload is journaled (encrypted); the key is re-derived from attemptId
    };
    session.update((j) => { j.swaps = [...j.swaps.filter((s) => s.orderId !== entry.orderId), entry]; });
    if (dueAt !== undefined) scheduleAction({ kind: "fund-escrow", orderId: entry.orderId, dueAt });
    setOrder(res.order); setStored(entry); setOrderKey(key); setRefundNoteData(refund.noteData);
    if (!destinationEdited) setDestination(dest);
  }

  /** Resume an order from the journal after a reload: the service rebuilds it from the same params (same escrow). */
  async function resume(s: StoredSwap) {
    const r = await run("Resuming the order…", async () => {
      const out = await swapService.resume({ request: s.request as any, policy: s.policy as Policy, provider: s.provider, params: s.params as any });
      const predicted = predictEscrow(swapFactory(), s.params as any);
      if (out.order.endpoint.toLowerCase() !== predicted.toLowerCase() || out.order.orderId.toLowerCase() !== s.orderId.toLowerCase()) throw new OrderMismatch("endpoint", "the resumed order is not the one this wallet committed");
      return out;
    });
    if (!r) return;
    reset();
    setOrder(r.order); setStored(s); setOrderKey(deriveOrderKey(masterSeed, s.attemptId as Hex)); setRefundNoteData((s.refundNoteData as Hex | undefined) ?? null);
    if (s.jobId && submission.kind === "relayer") relayerSwapStatus(submission.url, s.jobId).then(setJob).catch(() => {});
  }

  const fund = useCallback(async (s: StoredSwap) => {
    if (!deployment) throw new Error("No deployment configured (VITE_RPC_URLS / VITE_CORE / VITE_ETH_VAULT).");
    const a = assetOfStored(s);
    const gross = BigInt((s.params as any).amount); // the withdrawal funds the whole order; the escrow pays the executor tip
    if (noteStore.balance(BigInt(a.vault)) < gross) throw new Error(`Not enough ${a.symbol} in your private balance for this order.`);
    // the money goes only to the escrow these params create under our factory (recomputed again here)
    const predicted = predictEscrow(swapFactory(), s.params as any);
    if (predicted.toLowerCase() !== String(s.endpoint).toLowerCase()) throw new OrderMismatch("endpoint", `${s.endpoint} is not the escrow these params create (${predicted})`);
    const w = await privateWithdrawal({ masterSeed, deployment, amount: gross, recipient: predicted, vault: a.vault, onStatus: setBusy });
    patchStored(s.orderId, { fundedTx: w.txHash, state: "funded" });
    return w;
  }, [deployment, masterSeed, assets]);

  // the scheduler fires the private withdrawal at the drawn time while the wallet is unlocked
  useScheduler(useCallback(async (a) => {
    const s = session.journal().swaps.find((x) => x.orderId === a.orderId);
    if (!s || s.fundedTx) return;
    await fund(s);
  }, [fund]));

  async function fundNow() {
    if (!stored) return;
    const w = await run("Private withdrawal to the one-time escrow…", () => fund(stored));
    if (w) completeAction(`fund-escrow:${stored.orderId}`);
  }

  /**
   * Return a funded order to the private balance without executing it: hand the executor a refund-only
   * job (the journaled params and refund payload, no signature), which re-shields the escrow's balance as
   * the committed note once the window opens. For a call this wallet refused, a minimum the user does not
   * accept, or simply a change of mind; signing a fresh quote later still replaces it.
   */
  async function returnToBalance() {
    if (!order || !stored || !refundNoteData) return;
    if (submission.kind !== "relayer") { setError(`Switch to relayer submission (advanced), or call deployAndRefund on the factory yourself after ${new Date(order.params.refundAfter * 1000).toLocaleString()}.`); return; }
    const url = submission.url;
    const j = await run("Handing the refund to the relayer's executor…", async () => relayerSwapRefund(url, { factory: swapFactory(), params: stored.params as any, refundNoteData, ...(stored.refundTokens?.length ? { refundTokens: stored.refundTokens as Address[] } : {}) }));
    if (!j) return;
    setMoved(null); setJob(j);
    patchStored(order.orderId, { jobId: j.id, state: j.state });
  }

  /**
   * Re-quote with the escrow as sender, check the provider call, sign it locally, hand it to the executor.
   * Repeatable while the job is open. `acceptMin`: the user consented to a lower minimum than approved.
   */
  async function signAndHand(acceptMin?: bigint) {
    if (!order || !orderKey || !refundNoteData) return;
    if (!stored) { setError("This order is not in this wallet's journal, so its provider call cannot be checked; it is not signed."); return; }
    const a = assetOfStored(stored);
    const journaled = stored as unknown as JournaledOrder; // the wallet's own record: what it asked for, the params it committed, the minimum approved
    const r = await run("Re-quoting with the escrow as sender, then checking the call…", async () => {
      const prepared = await swapService.prepare(order.orderId);
      // the digest is of exactly the call shown; the call pays your fresh address from a pinned provider, refunds to the escrow, and guarantees the approved minimum
      const gate = await checkBeforeSigning({ prepared, order, journaled, factory: swapFactory(), chainId: BigInt(deployment!.chainId), acceptMin, pooled: (deployment?.erc20Vaults ?? []).map((v) => v.token) });
      if (!gate.ok) return { moved: gate.moved };
      const { params, call } = gate;
      setBusy("Signing locally…");
      const signature = await signExecutionDigest(orderKey.privateKey, prepared.digest); // the key never leaves this tab
      const fin = await swapService.finalize(order.orderId, signature);
      const label = `${a.token ? "" : fmt(fin.execution.value, 18) + " ETH · "}valid until ${new Date(fin.execution.deadline * 1000).toLocaleTimeString()}`;
      if (submission.kind !== "relayer") return { label, job: undefined, call };
      setBusy("Handing the signed order to the relayer's executor…");
      const health: ServiceHealth = await swapService.health();
      const factory = swapFactory();
      if (health.deployment.factory.toLowerCase() !== factory.toLowerCase()) throw new OrderMismatch("factory", `the swap service builds for ${health.deployment.factory}, this wallet for ${factory}`);
      const refundTokens = gate.call.refundTokens;
      if (refundTokens?.length) patchStored(order.orderId, { refundTokens });
      const j = await relayerSwapExecute(submission.url, { factory, params, execution: fin.execution, refundNoteData, ...(refundTokens?.length ? { refundTokens } : {}) });
      patchStored(order.orderId, { jobId: j.id, state: j.state });
      return { label, job: j, call };
    });
    if (!r) return;
    if ("moved" in r) { setMoved(r.moved ?? null); return; }
    setMoved(null);
    if (acceptMin !== undefined) patchStored(order.orderId, { approvedMin: acceptMin.toString() });
    setSigned(r.label); setChecked(r.call); if (r.job) setJob(r.job);
  }

  const chosen = quotes?.chosen;
  const chosenQuote = chosen ? quotes!.quotes.find((q) => q.provider === chosen.provider) : undefined;
  const funded = !!stored?.fundedTx;
  const dueAt = stored?.dueAt;
  const orderAsset = stored ? assetOfStored(stored) : fromAsset;

  return (
    <div className="panel">
      <h3>Swap privately</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        Your private balance pays a one-time address; the best route delivers to a fresh address of this wallet. A failed swap returns to your private balance by itself.
      </p>
      <AssetSelect assets={assets} value={fromAsset} onChange={(a) => { setFromAsset(a); setAmount(a.decimals === 18 ? "0.5" : "100"); setQuotes(null); reset(); }} label="From your private balance" />
      <label>Amount ({fromAsset.symbol})</label>
      <input value={amount} onChange={(e: any) => { setAmount(e.target.value.replace(/[^0-9.]/g, "")); setQuotes(null); reset(); }} />
      {units > 0n && !isBucketFor(fromAsset, units) && (
        <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>
          An exact amount is a fingerprint on the public side.{" "}
          {bucket ? <button className="tab" onClick={() => { setAmount(formatAmount(fromAsset, bucket)); setQuotes(null); reset(); }}>Use {formatAmount(fromAsset, bucket)} {fromAsset.symbol} (a public bucket; the rest stays private)</button> : "Choose a larger amount."}
        </p>
      )}
      <label>To</label>
      <select value={target} onChange={(e: any) => chooseTarget(e.target.value)}>
        {Object.keys(TARGETS).map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <label>Receive at {destinationEdited ? "(your own address)" : "(a fresh address of this wallet, reserved when you confirm)"}</label>
      <input value={destination} onChange={(e: any) => { setDestination(e.target.value); setDestinationEdited(e.target.value.trim() !== ""); }} placeholder="fresh address" />
      {destinationEdited && <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>Never use your public wallet address here. <button className="tab" onClick={() => { setDestinationEdited(false); setDestination(peekFreshAddress(masterSeed, chainKindOf(to.ref.chain)).address); }}>Use a fresh address</button></p>}
      <label>Priority</label>
      <select value={policy} onChange={(e: any) => { setPolicy(e.target.value); setQuotes(null); reset(); }}>
        <option value="best-privacy">Best privacy (funded at a random time within 6–72 h)</option>
        <option value="best-price">Best price (1–24 h)</option>
        <option value="fastest">Fastest (no delay; public submission)</option>
      </select>
      <button className="primary" onClick={getQuotes} disabled={!!busy || !destination || units <= 0n}>Get a quote</button>
      {busy && <p className="muted">{busy}</p>}
      {error && <p style={{ color: "var(--warn)" }}>{error}</p>}

      {quotes && !order && (
        <div style={{ marginTop: 14 }}>
          {chosen && chosenQuote ? (
            <>
              <div className="row"><span className="muted">Receive approximately</span><b>{fmt(chosenQuote.toAmount, to.ref.decimals)} {to.ref.symbol}</b></div>
              <div className="row"><span className="muted">At least</span><b>{fmt(chosenQuote.toAmountMin, to.ref.decimals)} {to.ref.symbol}</b></div>
              <div className="row"><span className="muted">Network</span><b>{to.network}</b></div>
              <div className="row"><span className="muted">Fee</span><b>{feeSummary(chosenQuote)}</b></div>
              <div className="row"><span className="muted">Estimated</span><b>~{hours(chosenQuote.etaSeconds)}{policy !== "fastest" ? " after the scheduled funding" : ""}</b></div>
              <div className="row"><span className="muted">Privacy</span><b>{chosen.components.privacy}/100</b></div>
              <div className="tabs" style={{ marginTop: 8 }}>
                <button className="primary" onClick={() => commit(chosen.provider)} disabled={!!busy}>Swap</button>
                <button className="tab" onClick={() => setShowRoute((v) => !v)}>{showRoute ? "Hide route" : "View route"}</button>
              </div>
            </>
          ) : (
            <p className="muted">No route available right now{Object.keys(quotes.errors).length ? ` (${Object.values(quotes.errors).join("; ")})` : ""}.</p>
          )}
          {showRoute && quotes.scores.map((s: RouteScore) => {
            const q = quotes.quotes.find((x) => x.provider === s.provider)!;
            return (
              <div key={s.provider} style={{ padding: "8px 0", borderTop: "1px solid var(--border)", opacity: s.filtered ? 0.55 : 1 }}>
                <div className="row"><b>{s.provider}{chosen?.provider === s.provider ? " · best route" : ""}</b><b>{fmt(q.toAmount, to.ref.decimals)} {to.ref.symbol}</b></div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Output at least {fmt(q.toAmountMin, to.ref.decimals)} · ~{hours(q.etaSeconds)} · Provider risk: {risk(s.components.security)} · Bridge: {q.nativeAssets ? "none (native assets)" : "wrapped leg"} · Settlement: {settlement(s.provider)} · Privacy {s.components.privacy}
                  {q.refundTarget === "destination" ? " · a failure refunds at the destination, not to the pool" : ""}
                  {quotes.links?.[s.provider]?.public ? " · the provider publishes the escrow → destination link (harmless: your escrow was funded privately; this swap is as private as your pool withdrawal)" : ""}
                  {advanced && quotes.links?.[s.provider] ? ` · link: ${quotes.links[s.provider].evidence}` : ""}
                  {s.filtered ? ` · not selectable: ${s.filtered}` : ""}
                  {advanced ? ` · score ${s.total} (price ${s.components.price}, security ${s.components.security}, latency ${s.components.latency}, reliability ${s.components.reliability})` : ""}
                </div>
                {!s.filtered && chosen?.provider !== s.provider && <button className="tab" style={{ marginTop: 4 }} onClick={() => commit(s.provider)} disabled={!!busy}>Use this route</button>}
              </div>
            );
          })}
          {showRoute && Object.entries(quotes.errors).map(([p, e]) => <div key={p} className="muted" style={{ fontSize: 12, padding: "4px 0" }}>{p}: {e}</div>)}
          <Scorecard action="swap" facts={{ delaySeconds: DELAY_WINDOW[policy][0], amountIsBucket: isBucketFor(fromAsset, units), privateSubmission: submission.kind === "relayer" && policy !== "fastest", rpcEndpoints: deployment?.rpcUrls?.length ?? 1, recipientFresh: !destinationEdited, provider: chosen && chosenQuote ? { crossChainScore: chosen.components.privacy, nativeAssets: chosenQuote.nativeAssets, kind: providerKind(chosen.provider) } : undefined }} />
        </div>
      )}

      {!order && openSwaps.length > 0 && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <label>Your open swaps</label>
          {openSwaps.map((s) => {
            const a = assetOfStored(s);
            return (
              <div key={s.orderId} className="row" style={{ fontSize: 13, padding: "4px 0" }}>
                <span>{formatAmount(a, BigInt((s.params as any).amount))} {a.symbol} → {(s.request as any).to.symbol} · {s.state}{s.dueAt && !s.fundedTx ? ` · funding ${new Date(s.dueAt).toLocaleString()}` : ""}</span>
                <span className="tabs" style={{ margin: 0 }}>
                  <button className="tab" onClick={() => resume(s)} disabled={!!busy}>Open</button>
                  {!s.fundedTx && <button className="tab" onClick={() => { session.update((j) => { const x = j.swaps.find((y) => y.orderId === s.orderId); if (x) x.state = "abandoned"; }); completeAction(`fund-escrow:${s.orderId}`, "abandoned"); }}>Abandon</button>}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {order && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <div className="row"><span className="muted">Receive at</span><code style={{ fontSize: 11 }}>{(stored?.request as any)?.destination ?? destination}</code></div>
          <div className="row"><span className="muted">Privacy</span><b>{order.privacy.score}/100</b></div>
          <div className="row"><span className="muted">{funded ? "Funded" : dueAt ? "Funding scheduled" : "Funding"}</span><b>{funded ? `tx ${stored!.fundedTx!.slice(0, 10)}…` : dueAt ? `${new Date(dueAt).toLocaleString()} (random within ${hours(order.privacy.delaySeconds[0])}–${hours(order.privacy.delaySeconds[1])}; keep the wallet unlocked)` : "now"}</b></div>
          <div className="row"><span className="muted">Returns to your private balance if not executed by</span><b>{new Date(order.params.refundAfter * 1000).toLocaleString()}</b></div>
          {advanced && (
            <>
              <div className="row"><span className="muted">Route</span><b>{order.quote.provider}</b></div>
              <div className="row"><span className="muted">One-time escrow (withdrawal recipient)</span><code>{order.endpoint}</code></div>
              <div className="row"><span className="muted">Executor tip</span><b>{formatAmount(orderAsset, BigInt(order.params.executorTip))} {orderAsset.symbol}</b></div>
              <div className="row"><span className="muted">Order key (one-time)</span><code>{orderKey?.address}</code></div>
            </>
          )}
          <div className="tabs" style={{ marginTop: 10 }}>
            <button className="primary" onClick={fundNow} disabled={!!busy || funded} title={dueAt ? "Funding now shortens the random delay and weakens timing privacy" : undefined}>{dueAt && !funded ? "1 · Fund now (less timing privacy)" : "1 · Fund the swap from your private balance"}</button>
            <button className="primary" onClick={() => signAndHand()} disabled={!!busy || !funded || (!!job && !OPEN_FOR_RESIGN.includes(job.state))}>
              {job && OPEN_FOR_RESIGN.includes(job.state) ? "2 · Confirm again with a fresh quote" : "2 · Confirm the swap"}
            </button>
            {funded && CAN_RETURN(job) && <button className="tab" onClick={returnToBalance} disabled={!!busy} title="The order is not executed; its escrow re-shields into your private balance once the window opens">Return to my private balance</button>}
          </div>
          {moved && (() => {
            const t = (stored?.request as any)?.to as AssetRef | undefined;
            const dec = t?.decimals ?? to.ref.decimals, sym = t?.symbol ?? to.ref.symbol;
            const drop = moved.approved > 0n ? Number(((moved.approved - moved.minOut) * 10000n) / moved.approved) / 100 : 0;
            return (
              <div style={{ marginTop: 8, padding: 8, border: "1px solid var(--warn)", borderRadius: 6 }}>
                <p style={{ fontSize: 13, margin: 0 }}>The price moved. This route now guarantees at least <b>{fmt(moved.minOut.toString(), dec)} {sym}</b>; you approved {fmt(moved.approved.toString(), dec)} {sym} (−{drop} %). Nothing has been signed.</p>
                <p className="muted" style={{ fontSize: 12 }}>Confirm at the new minimum, or wait and confirm later against a fresh quote. An order that is never confirmed returns to your private balance after {new Date(order.params.refundAfter * 1000).toLocaleString()}.</p>
                <button className="tab" onClick={() => signAndHand(moved.minOut)} disabled={!!busy}>Confirm at the new minimum</button>
                <button className="tab" onClick={returnToBalance} disabled={!!busy}>Return it to my private balance instead</button>
              </div>
            );
          })()}
          {checked && (
            <p className="muted" style={{ fontSize: 12 }}>
              Checked by this wallet before signing: pays your fresh address{checked.minOut !== null ? `, at least ${fmt(checked.minOut.toString(), ((stored?.request as any)?.to as AssetRef | undefined)?.decimals ?? to.ref.decimals)} ${((stored?.request as any)?.to as AssetRef | undefined)?.symbol ?? to.ref.symbol}` : ", minimum not readable (Fastest)"}; {checked.refundTo === "escrow" ? "a provider refund returns to your private balance" : checked.refundTo === "destination" ? "a failed order refunds at your fresh address, not to your private balance" : "a failed order refunds by the provider's rules"}.
              {advanced ? ` (${checked.provider}: ${checked.facts.join("; ")})` : ""}
            </p>
          )}
          {signed && <p className="muted" style={{ fontSize: 12 }}>Confirmed: {signed}{submission.kind !== "relayer" ? " — submit deployAndExecute yourself or switch to relayer submission (advanced)." : ""}</p>}
          {job
            ? <p className="muted" style={{ fontSize: 12 }}>Status: <b>{swapJobStatus(job.state)}</b>{advanced ? ` (${job.state}${job.txHash ? `, tx ${job.txHash.slice(0, 10)}…` : ""}${job.error ? `, ${job.error}` : ""})` : ""} — refreshed every 15 s{OPEN_FOR_RESIGN.includes(job.state) ? "; the quote expired: confirm again with a fresh one" : ""}.</p>
            : <p className="muted" style={{ fontSize: 12 }}>Status: Pending — {funded ? "confirm the swap against a fresh quote, or return it to your private balance." : dueAt ? "the funding fires at the scheduled time while the wallet is unlocked." : "fund the swap, then confirm it."}</p>}
          {job?.state === "refund-only" && <p className="muted" style={{ fontSize: 12 }}>Returning to your private balance: the escrow re-shields as your pre-committed note after {new Date(order.params.refundAfter * 1000).toLocaleString()}; it is added to your private balance when the executor reports it (a rescan finds it too).</p>}
          {refundLine && <p className="muted" style={{ fontSize: 12 }}>{refundLine}</p>}
        </div>
      )}
    </div>
  );
}
