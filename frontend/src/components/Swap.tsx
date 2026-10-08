import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { formatUsd, tierLabel } from "@ref/wallet/valuation";
import { levelOf } from "@ref/wallet/privacyCenter";
import { parseDestination } from "@ref/wallet/destinations";
import { unacknowledgedBlocks, type LintId } from "@ref/wallet/privacyLint";
import { feeSummary, swapService, type AssetRef, type Policy, type QuoteSet, type RouteScore, type ServiceHealth, type ServiceOrder } from "../sdk/swapService";
import { deriveOrderKey, deriveRefundNote, signExecutionDigest } from "../keys/swapKeys";
import { checkOrder, OrderMismatch, predictEscrow } from "../sdk/swapGuard";
import type { CheckedCall, MinimumMoved } from "../sdk/providerCall";
import { checkBeforeSigning, type JournaledOrder } from "../sdk/swapSign";
import { chainKindOf, consumeFreshAddress, peekFreshAddress } from "../keys/chainKeys";
import { recoverSwapRefunds } from "../sdk/privateTx";
import type { Deployment } from "../sdk/chain";
import { assetByVault, assetsOf, bucketBelowFor, formatAmount, isBucketFor, parseAmount, type Asset } from "../sdk/assets";
import { relayerInfo, relayerSwapExecute, relayerSwapRefund, relayerSwapStatus, swapJobStatus, type SwapJob } from "../sdk/relayer";
import { fmtUnits } from "../sdk/format";
import { DELAY_WINDOW, policyFromPreference } from "../sdk/policy";
import { priceStore } from "../sdk/prices";
import { holdersAbove } from "../sdk/poolDeposits";
import { simulateExecution } from "../sdk/simulate";
import { abandonSwap, assetOfStored, fundEscrow, isOpenSwap, patchSwap, swapFactoryOf } from "../sdk/swapFunding";
import { noteStore } from "../wallet/notes";
import { useSettings } from "../wallet/settings";
import { session, useSession } from "../wallet/session";
import type { StoredSwap } from "../wallet/journal";
import { activityId, recordActivity } from "../wallet/activity";
import { topBucket, walletLint } from "../wallet/lintFacts";
import { completeAction, sampleDueAt, scheduleAction } from "../wallet/schedule";
import { AssetSelect } from "./AssetSelect";
import { DestinationCard } from "./DestinationCard";
import { PrivacyLint } from "./PrivacyLint";
import { Scorecard } from "./Scorecard";

// Private swap (spec v1.1, plan §22, §26–§31, §36, §47, §79; whale spec §23): quote every provider through
// the local service, show ONE route in plain words — "Best route: Automatic", the privacy, price and time
// levels; providers only behind "Route details" — commit an order whose source is a one-time escrow and
// whose destination is a fresh address of this wallet, FUND the escrow with a private withdrawal (ETH or
// an ERC-20 from its own vault) at a random time inside the policy's delay window (the order and its
// schedule live in the encrypted journal; the App-level scheduler fires it from any tab), then re-quote
// with the escrow as sender, sign the provider call with the one-time key and hand it to a relayer's
// executor, which deploys + executes for its tip and refunds to the pre-committed note after the window.
// If the signed quote expires before execution, sign again. The permanent address never touches a
// provider. The trade preference lives in Settings (never here, never on chain); the service derives the
// policy from it and the value tier. Before the order key signs, the wallet reads the provider call itself
// (sdk/providerCall.ts): pinned contract, your fresh address as receiver, refunds to the escrow, and a
// minimum no lower than the one you approved — a lower one needs your fresh consent.
const TARGETS: Record<string, { ref: AssetRef; network: string }> = {
  BTC: { ref: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, network: "Bitcoin" },
  SOL: { ref: { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" }, network: "Solana" },
  "USDC on Base": { ref: { chain: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" }, network: "Base" },
  "ETH on Base": { ref: { chain: "base", asset: "native", decimals: 18, symbol: "ETH" }, network: "Base" },
};
const fmt = (units: string, decimals: number) => fmtUnits(units, decimals); // from base units, never through a float
const hours = (s: number) => (s >= 3600 ? `${Math.round(s / 3600)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);
const OPEN_FOR_RESIGN = ["expired", "execute-failed", "refund-only"];
/** A funded order can still be returned unexecuted while no execution is running or settled. */
const CAN_RETURN = (job: SwapJob | null) => !job || ["waiting-funding", "expired", "execute-failed"].includes(job.state);
const risk = (security: number) => (security >= 85 ? "Low" : security >= 70 ? "Medium" : "High");
const settlement = (p: string) => (p === "thorchain" || p === "chainflip" ? "native deposit address" : p === "near-intents" ? "solver network" : p === "mayan" ? "signed intent (drivers compete)" : "aggregator / bridge");
const providerKind = (p: string): "deposit-address" | "signed-intent" | "aggregator-api" => (p === "thorchain" || p === "chainflip" || p === "near-intents" ? "deposit-address" : p === "mayan" ? "signed-intent" : "aggregator-api");
const refOf = (a: Asset): AssetRef => ({ chain: "ethereum", asset: a.token ?? "native", decimals: a.decimals, symbol: a.symbol });

export function Swap({ masterSeed, deployment, account = null }: { masterSeed: Uint8Array; deployment: Deployment | null; /** the connected public wallet, if any: a destination equal to it is flagged */ account?: string | null }) {
  const { submission, advanced, preference, verifyReads } = useSettings();
  useSession(); // re-render when the journal-backed session changes
  const assets = assetsOf(deployment);
  const [fromAsset, setFromAsset] = useState(assets[0]);
  const [target, setTarget] = useState("BTC");
  const [amount, setAmount] = useState("0.5");
  const [destination, setDestination] = useState(() => peekFreshAddress(masterSeed, "bitcoin").address);
  const [destinationEdited, setDestinationEdited] = useState(false);
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
  const [acknowledged, setAcknowledged] = useState<LintId[]>([]);
  const [holders, setHolders] = useState<number | null>(null);

  const to = TARGETS[target];
  const units = parseAmount(fromAsset, amount);
  const bucket = bucketBelowFor(fromAsset, units);
  // a typed destination is parsed for the destination chain (whale spec §21): another chain's address is refused by name
  const parsedDestination = destinationEdited ? parseDestination(chainKindOf(to.ref.chain), destination) : null;
  const destinationError = parsedDestination && !parsedDestination.ok ? parsedDestination.reason : "";
  // a piece above the common sizes: how many holders could pay it, from the pool's public deposits (on this input, never at launch)
  useEffect(() => {
    if (!deployment || units <= topBucket(fromAsset.decimals)) { setHolders(null); return; }
    let live = true;
    holdersAbove(deployment, fromAsset.vault, units).then((h) => { if (live) setHolders(h); }).catch(() => { if (live) setHolders(null); });
    return () => { live = false; };
  }, [deployment, units, fromAsset]);
  // the value tier (whale spec §13): the wallet's own assessment is a hint the service can only raise; the fail-safe is at least high-value
  const assessment = units > 0n ? priceStore.assess(units, fromAsset) : null;
  const usd = assessment && "usd" in assessment.value ? assessment.value.usd : null;
  /** the policy the service scored under (its tier override applied), or the preference's own before a quote */
  const policy: Policy = quotes?.policy ?? policyFromPreference(preference);
  const request = () => ({ from: refOf(fromAsset), to: to.ref, amount: units.toString(), destination, slippageBps: 50, preference, ...(assessment ? { tier: assessment.tier } : {}), destinationKind: (destinationEdited ? "entered" : "fresh") as "entered" | "fresh", preferNative: preference === "native" });
  const openSwaps = session.isUnlocked() ? session.journal().swaps.filter(isOpenSwap) : [];
  const assetOf = (s: StoredSwap): Asset => assetOfStored(deployment, s);

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
    const t = setInterval(() => relayerSwapStatus(url, job.id).then((j) => { setJob(j); patchStored(job.id, { state: j.state, ...(j.executionTx ? { executionTx: j.executionTx } : {}) }); }).catch(() => {}), 15_000);
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
        for (const r of mine) {
          const a = assetByVault(deployment, r.note.vaultId);
          recordActivity({ id: activityId("refund", `${orderId}:${r.leafIndex}`), kind: "refund", asset: a?.symbol ?? "units", decimals: a?.decimals ?? 0, amount: r.note.amount.toString(), status: "completed", ref: stored.orderId, note: "a swap returned to your private balance" });
        }
        setRefundLine(mine.length ? `Refunded: ${mine.map(amount).join(" + ")} back in your private balance.` : "Refunded on chain; the refund is not in the pool view yet. Rescan under Home → Details shortly.");
      })
      .catch((e) => live && setRefundLine(`Refunded on chain; recording the note failed (${e?.message ?? e}). Rescan under Home → Details.`));
    return () => { live = false; };
  }, [job?.state, stored?.orderId, deployment]);

  function reset() { setOrder(null); setStored(null); setOrderKey(null); setRefundNoteData(null); setSigned(null); setChecked(null); setMoved(null); setJob(null); setShowRoute(false); setRefundLine(""); }
  function patchStored(orderId: string, patch: Partial<StoredSwap>) {
    patchSwap(orderId, patch);
    setStored((s) => (s && s.orderId.toLowerCase() === orderId.toLowerCase() ? { ...s, ...patch } : s));
  }

  async function getQuotes() {
    reset();
    const set = await run("Finding the best route…", () => swapService.quote(request()));
    if (set) setQuotes(set);
  }

  async function commit(provider?: string) {
    // the signer must be fixed at commit time, before the service chooses the orderId, so a one-time
    // key is derived per attempt from a random attempt id (never reused: a new attempt, a new key)
    let factory: Address;
    try { factory = swapFactoryOf(deployment); } catch (e: any) { setError(e.message); return; }
    const attemptId = ("0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
    const key = deriveOrderKey(masterSeed, attemptId);
    const refundCounter = noteStore.allocateCounter();
    const refund = deriveRefundNote(masterSeed, refundCounter);
    const shown = quotes?.quotes.find((q) => q.provider === (provider ?? quotes.chosen?.provider)); // the minimum the user saw and approved
    const dest = destinationEdited ? destination : consumeFreshAddress(masterSeed, chainKindOf(to.ref.chain)).address; // reserve the fresh address now
    const req = { ...request(), destination: dest };
    const res = await run("Committing the order…", async () => {
      const r = await swapService.order({ ...req, policy, provider, orderSigner: key.address, refundOwnerCommitment: refund.ownerCommitment.toString(), refundNoteSecret: refund.noteSecret.toString(), refundNoteDataHash: refund.noteDataHash });
      // the escrow is recomputed here from OUR factory and the params; every field we chose is checked
      checkOrder(r.order, { factory, orderSigner: key.address as Address, refund, amount: BigInt(req.amount), asset: fromAsset });
      return r;
    });
    if (!res) return;
    reset();
    const orderPolicy: Policy = res.order.policy ?? res.policy ?? policy;
    const dueAt = orderPolicy === "fastest" ? undefined : sampleDueAt(DELAY_WINDOW[orderPolicy]);
    const entry: StoredSwap = {
      orderId: res.order.orderId, attemptId, refundCounter, provider: res.order.quote.provider, policy: orderPolicy, request: { from: req.from, to: req.to, amount: req.amount, destination: req.destination, slippageBps: req.slippageBps },
      params: res.order.params, endpoint: res.order.endpoint, quote: res.order.quote, approvedMin: (shown ?? res.order.quote).toAmountMin, createdAt: Date.now(), dueAt, state: "committed", refundNoteData: refund.noteData, // the random payload is journaled (encrypted); the key is re-derived from attemptId
      preference, tier: res.order.tier ?? res.tier, value: res.order.value ?? res.value, plan: res.order.plan ?? shown?.plan,
    };
    if (lintItems) entry.lint = { items: lintItems, at: Date.now() };
    session.update((j) => { j.swaps = [...j.swaps.filter((s) => s.orderId !== entry.orderId), entry]; });
    recordActivity({ id: activityId("swap", entry.orderId), kind: "swap", asset: fromAsset.symbol, decimals: fromAsset.decimals, amount: req.amount, status: "committed", ref: entry.orderId, note: `→ ${to.ref.symbol}` });
    if (dueAt !== undefined) scheduleAction({ kind: "fund-escrow", orderId: entry.orderId, dueAt });
    setOrder(res.order); setStored(entry); setOrderKey(key); setRefundNoteData(refund.noteData);
    if (!destinationEdited) setDestination(dest);
  }

  /** Resume an order from the journal after a reload: the service rebuilds it from the same params (same escrow). */
  async function resume(s: StoredSwap) {
    const r = await run("Resuming the order…", async () => {
      const out = await swapService.resume({ request: s.request as any, policy: s.policy as Policy, provider: s.provider, params: s.params as any, ...(s.tier ? { tier: s.tier as any } : {}), ...(s.preference ? { preference: s.preference as any } : {}) });
      const predicted = predictEscrow(swapFactoryOf(deployment), s.params as any);
      if (out.order.endpoint.toLowerCase() !== predicted.toLowerCase() || out.order.orderId.toLowerCase() !== s.orderId.toLowerCase()) throw new OrderMismatch("endpoint", "the resumed order is not the one this wallet committed");
      return out;
    });
    if (!r) return;
    reset();
    setOrder(r.order); setStored(s); setOrderKey(deriveOrderKey(masterSeed, s.attemptId as Hex)); setRefundNoteData((s.refundNoteData as Hex | undefined) ?? null);
    if (s.jobId && submission.kind === "relayer") relayerSwapStatus(submission.url, s.jobId).then(setJob).catch(() => {});
  }

  async function fundNow() {
    if (!stored) return;
    const w = await run("Private withdrawal to the one-time escrow…", async () => {
      const r = await fundEscrow({ masterSeed, deployment, stored, onStatus: setBusy });
      setStored((s) => (s ? { ...s, fundedTx: r.txHash, state: "funded" } : s));
      return r;
    });
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
    if (submission.kind !== "relayer") { setError(`Switch to relayer submission (Settings), or call deployAndRefund on the factory yourself after ${new Date(order.params.refundAfter * 1000).toLocaleString()}.`); return; }
    const url = submission.url;
    const j = await run("Handing the refund to the relayer's executor…", async () => relayerSwapRefund(url, { factory: swapFactoryOf(deployment), params: stored.params as any, refundNoteData, ...(stored.refundTokens?.length ? { refundTokens: stored.refundTokens as Address[], refundFloors: stored.refundFloors } : {}) }));
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
    const a = assetOf(stored);
    const journaled = stored as unknown as JournaledOrder; // the wallet's own record: what it asked for, the params it committed, the minimum approved
    const r = await run("Re-quoting with the escrow as sender, then checking the call…", async () => {
      const prepared = await swapService.prepare(order.orderId);
      // the digest is of exactly the call shown; the call pays your fresh address from a pinned provider, refunds to the escrow, and guarantees the approved minimum
      const gate = await checkBeforeSigning({ prepared, order, journaled, factory: swapFactoryOf(deployment), chainId: BigInt(deployment!.chainId), acceptMin, pooled: (deployment?.erc20Vaults ?? []).map((v) => v.token) });
      if (!gate.ok) return { moved: gate.moved };
      const { params, call } = gate;
      setBusy("Signing locally…");
      const signature = await signExecutionDigest(orderKey.privateKey, prepared.digest); // the key never leaves this tab
      // the signed execution is simulated on every RPC endpoint before it leaves this wallet (whale spec §24): a revert keeps the signature here
      setBusy("Simulating the execution through your RPC endpoints…");
      const tipRecipient = submission.kind === "relayer" ? await relayerInfo(submission.url).then((i) => i.relayer).catch(() => undefined) : undefined;
      const sim = await simulateExecution({ deployment: deployment!, factory: swapFactoryOf(deployment), params, execution: { provider: prepared.provider, value: BigInt(prepared.value), providerCalldata: prepared.calldata, deadline: prepared.deadline, signature }, account: tipRecipient });
      patchStored(order.orderId, { simulation: { ok: sim.ok, at: Date.now(), ...(sim.ok ? { gas: sim.gas.toString() } : { error: sim.error, reason: sim.reason }) } });
      if (!sim.ok) throw new Error(`Not handed over: ${sim.reason}. The signature stays in this wallet; confirm again later against a fresh quote, or return the order to your private balance.`);
      const fin = await swapService.finalize(order.orderId, signature);
      const label = `${a.token ? "" : fmt(fin.execution.value, 18) + " ETH · "}valid until ${new Date(fin.execution.deadline * 1000).toLocaleTimeString()}`;
      if (submission.kind !== "relayer") return { label, job: undefined, call };
      setBusy("Handing the signed order to the relayer's executor…");
      const health: ServiceHealth = await swapService.health();
      const factory = swapFactoryOf(deployment);
      if (health.deployment.factory.toLowerCase() !== factory.toLowerCase()) throw new OrderMismatch("factory", `the swap service builds for ${health.deployment.factory}, this wallet for ${factory}`);
      const { refundTokens, refundFloors } = gate.call;
      if (refundTokens?.length) patchStored(order.orderId, { refundTokens, refundFloors });
      const j = await relayerSwapExecute(submission.url, { factory, params, execution: fin.execution, refundNoteData, ...(refundTokens?.length ? { refundTokens, refundFloors } : {}) });
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
  const orderAsset = stored ? assetOf(stored) : fromAsset;
  const window = DELAY_WINDOW[policy];
  const quotedOnly = quotes?.competition ? quotes.competition.filter((c) => c.outcome === "quoted").length : undefined;
  const lintInput = { tier: assessment?.tier ?? ("standard" as const), deployment, settings: { submission, verifyReads }, account, amount: units, decimals: fromAsset.decimals, amountIsBucket: isBucketFor(fromAsset, units), holders, acknowledged };
  // the privacy lint (whale spec §18) with the quote, and again with what the wallet read in the provider call
  const lintItems = quotes && chosen ? walletLint({ ...lintInput, action: "swap", destination, destinationKind: destinationEdited ? "entered" : "fresh", delaySeconds: window[0], quotes, chosenProvider: chosen.provider }) : null;
  const signLint = checked && stored ? walletLint({ ...lintInput, action: "swap", destination: String((stored.request as { destination?: string })?.destination ?? destination), destinationKind: destinationEdited ? "entered" : "fresh", delaySeconds: window[0], quotes, chosenProvider: stored.provider, checked, approvedMin: stored.approvedMin ? BigInt(stored.approvedMin) : null }) : null;
  const blocked = lintItems ? unacknowledgedBlocks(lintItems).length > 0 : false;

  return (
    <div className="panel" data-testid="swap">
      <h3>Swap privately</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        Your private balance pays a one-time address; the best route delivers to a fresh address of this wallet. A failed swap returns to your private balance by itself.
      </p>
      <AssetSelect assets={assets} value={fromAsset} onChange={(a) => { setFromAsset(a); setAmount(a.decimals === 18 ? "0.5" : "100"); setQuotes(null); reset(); }} label="From your private balance" />
      <label>Amount ({fromAsset.symbol}){usd !== null ? ` · ≈ ${formatUsd(usd)}` : ""}</label>
      <input value={amount} onChange={(e: any) => { setAmount(e.target.value.replace(/[^0-9.]/g, "")); setQuotes(null); reset(); }} inputMode="decimal" />
      {units > 0n && !isBucketFor(fromAsset, units) && (
        <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>
          An exact amount is a fingerprint on the public side.{" "}
          {bucket ? <button className="tab" onClick={() => { setAmount(formatAmount(fromAsset, bucket)); setQuotes(null); reset(); }}>Use {formatAmount(fromAsset, bucket)} {fromAsset.symbol} (a public bucket; the rest stays private)</button> : "Choose a larger amount."}
        </p>
      )}
      {assessment && assessment.tier !== "standard" && (
        <p className="notice" style={{ marginTop: -4, marginBottom: 10 }}>
          {assessment.failSafe ? "No price is available, so this swap is treated as a large transfer: " : `${tierLabel[assessment.tier]}: `}
          the route must be confirmed by two live quotes or acknowledged, the price guard tightens, and the review steps of a large transfer apply.
        </p>
      )}
      <label>To</label>
      <select value={target} onChange={(e: any) => chooseTarget(e.target.value)}>
        {Object.keys(TARGETS).map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <label>Receive at {destinationEdited ? "(your own address)" : "(a fresh address of this wallet, reserved when you confirm)"}</label>
      <input value={destination} onChange={(e: any) => { setDestination(e.target.value); setDestinationEdited(e.target.value.trim() !== ""); }} placeholder="fresh address" />
      {destinationEdited && <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>Never use your public wallet address here. <button className="tab" onClick={() => { setDestinationEdited(false); setDestination(peekFreshAddress(masterSeed, chainKindOf(to.ref.chain)).address); }}>Use a fresh address</button></p>}
      {destinationError && <p className="error" style={{ fontSize: 13, marginTop: -4 }} data-testid="destination-error">Destination: {destinationError}.</p>}
      <p className="muted" style={{ fontSize: 12 }}>Funded at a random time within {window[1] === 0 ? "no delay (your preference is Fastest)" : `${hours(window[0])}–${hours(window[1])}`}; change the trade preference under Settings.</p>
      <button className="primary" onClick={getQuotes} disabled={!!busy || !destination || units <= 0n || !!destinationError}>Get a quote</button>
      {busy && <p className="muted">{busy}</p>}
      {error && <p style={{ color: "var(--warn)" }}>{error}</p>}

      {quotes && !order && (
        <div style={{ marginTop: 14 }} data-testid="quote">
          {chosen && chosenQuote ? (
            <>
              <div className="row"><span className="muted">Best route</span><b>Automatic</b></div>
              <div className="row"><span className="muted">Receive approximately</span><b>{fmt(chosenQuote.toAmount, to.ref.decimals)} {to.ref.symbol}</b></div>
              <div className="row"><span className="muted">At least</span><b>{fmt(chosenQuote.toAmountMin, to.ref.decimals)} {to.ref.symbol}</b></div>
              <div className="row"><span className="muted">Network</span><b>{to.network}</b></div>
              <div className="row"><span className="muted">Privacy</span><b className={`level-${levelOf(chosen.components.privacy)}`}>{levelOf(chosen.components.privacy)}</b></div>
              <div className="row"><span className="muted">Price</span><b className={`level-${levelOf(chosen.components.price)}`}>{levelOf(chosen.components.price)}</b></div>
              <div className="row"><span className="muted">Time</span><b>~{hours(chosenQuote.etaSeconds)}{policy !== "fastest" ? " after the scheduled funding" : ""}</b></div>
              <div className="row"><span className="muted">Fee</span><b>{feeSummary(chosenQuote)}</b></div>
              {quotedOnly === 1 && <p className="notice">Only one provider answered for this size; the route cannot be compared with another live quote.</p>}
              <DestinationCard network={to.network} asset={to.ref.symbol} address={destination} amount={fmt(chosenQuote.toAmount, to.ref.decimals)} kind={destinationEdited ? "entered" : "fresh"} />
              {lintItems && <PrivacyLint items={lintItems} onAcknowledge={(id) => setAcknowledged((a) => [...a, id])} />}
              <div className="tabs" style={{ marginTop: 8 }}>
                <button className="primary" onClick={() => commit(chosen.provider)} disabled={!!busy || blocked} title={blocked ? "Acknowledge the privacy check first" : undefined}>Swap</button>
                <button className="tab" onClick={() => setShowRoute((v) => !v)}>{showRoute ? "Hide route details" : "Route details"}</button>
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
                  {q.plan && q.plan.mode !== "single" ? ` · ${q.plan.parts} parts over ~${hours(q.plan.expectedSeconds)}` : ""}
                  {q.refundTarget === "destination" ? " · a failure refunds at the destination, not to the pool" : ""}
                  {quotes.links?.[s.provider]?.public ? " · the provider publishes the escrow → destination link (harmless: your escrow was funded privately; this swap is as private as your pool withdrawal)" : ""}
                  {advanced && quotes.links?.[s.provider] ? ` · link: ${quotes.links[s.provider].evidence}` : ""}
                  {s.filtered ? ` · not selectable: ${s.filtered}` : ""}
                  {advanced ? ` · score ${s.total} (price ${s.components.price}, security ${s.components.security}, latency ${s.components.latency}, reliability ${s.components.reliability}, liquidity ${s.components.liquidity})` : ""}
                </div>
                {!s.filtered && chosen?.provider !== s.provider && <button className="tab" style={{ marginTop: 4 }} onClick={() => commit(s.provider)} disabled={!!busy || blocked}>Use this route</button>}
              </div>
            );
          })}
          {showRoute && quotes.competition?.filter((c) => c.outcome !== "quoted").map((c) => <div key={c.provider} className="muted" style={{ fontSize: 12, padding: "4px 0" }}>{c.provider}: {c.outcome}{c.reason ? ` (${c.reason})` : ""}</div>)}
          {showRoute && !quotes.competition && Object.entries(quotes.errors).map(([p, e]) => <div key={p} className="muted" style={{ fontSize: 12, padding: "4px 0" }}>{p}: {e}</div>)}
          <Scorecard action="swap" facts={{ delaySeconds: window[0], amountIsBucket: isBucketFor(fromAsset, units), privateSubmission: submission.kind === "relayer" && policy !== "fastest", rpcEndpoints: deployment?.rpcUrls?.length ?? 1, recipientFresh: !destinationEdited, provider: chosen && chosenQuote ? { crossChainScore: chosen.components.privacy, nativeAssets: chosenQuote.nativeAssets, kind: providerKind(chosen.provider) } : undefined }} />
        </div>
      )}

      {!order && openSwaps.length > 0 && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <label>Your open swaps</label>
          {openSwaps.map((s) => {
            const a = assetOf(s);
            return (
              <div key={s.orderId} className="row" style={{ fontSize: 13, padding: "4px 0" }}>
                <span>{formatAmount(a, BigInt((s.params as any).amount))} {a.symbol} → {(s.request as any).to.symbol} · {s.state}{s.dueAt && !s.fundedTx ? ` · funding ${new Date(s.dueAt).toLocaleString()}` : ""}</span>
                <span className="tabs" style={{ margin: 0 }}>
                  <button className="tab" onClick={() => resume(s)} disabled={!!busy}>Open</button>
                  {!s.fundedTx && <button className="tab" onClick={() => abandonSwap(s.orderId)}>Abandon</button>}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {order && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <DestinationCard network={TARGETS[Object.keys(TARGETS).find((k) => TARGETS[k].ref.symbol === ((stored?.request as any)?.to?.symbol ?? to.ref.symbol) && TARGETS[k].ref.chain === ((stored?.request as any)?.to?.chain ?? to.ref.chain)) ?? target].network} asset={(stored?.request as any)?.to?.symbol ?? to.ref.symbol} address={(stored?.request as any)?.destination ?? destination} amount={stored?.approvedMin ? `at least ${fmt(stored.approvedMin, (stored.request as any)?.to?.decimals ?? to.ref.decimals)}` : undefined} title="Receive at" />
          <div className="row"><span className="muted">Privacy</span><b className={`level-${levelOf(order.privacy.score)}`}>{levelOf(order.privacy.score)}{advanced ? ` (${order.privacy.score}/100)` : ""}</b></div>
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
          {signLint && <PrivacyLint items={signLint} compact />}
          {stored?.simulation && <p className="muted" style={{ fontSize: 12 }}>{stored.simulation.ok ? `Simulated on your RPC endpoints before hand-over${stored.simulation.gas ? ` (about ${Number(stored.simulation.gas).toLocaleString()} gas)` : ""}.` : `The last simulation failed: ${stored.simulation.reason ?? stored.simulation.error}.`}</p>}
          {signed && <p className="muted" style={{ fontSize: 12 }}>Confirmed: {signed}{submission.kind !== "relayer" ? " — submit deployAndExecute yourself or switch to relayer submission (Settings)." : ""}</p>}
          {job
            ? <p className="muted" style={{ fontSize: 12 }}>Status: <b>{swapJobStatus(job.state)}</b>{advanced ? ` (${job.state}${job.txHash ? `, tx ${job.txHash.slice(0, 10)}…` : ""}${job.error ? `, ${job.error}` : ""})` : ""} — refreshed every 15 s{OPEN_FOR_RESIGN.includes(job.state) ? "; the quote expired: confirm again with a fresh one" : ""}.</p>
            : <p className="muted" style={{ fontSize: 12 }}>Status: Pending — {funded ? "confirm the swap against a fresh quote, or return it to your private balance." : dueAt ? "the funding fires at the scheduled time while the wallet is unlocked, on any screen." : "fund the swap, then confirm it."}</p>}
          {job?.state === "executed" && <p className="muted" style={{ fontSize: 12 }}>{(checked?.refundTo ?? (stored?.quote as { refundTarget?: string } | undefined)?.refundTarget) === "destination"
            ? "Handed to the provider. If it cannot deliver, it refunds at your fresh address on the destination chain, not to the pool."
            : `Handed to the provider. If it cannot deliver, it refunds the escrow, and the executor re-shields that into your private balance when it arrives within its watch (by default a day after ${new Date(order.params.refundAfter * 1000).toLocaleString()}). An amount too small to be worth a re-shield is left in the escrow, where anyone can re-shield it.`}</p>}
          {job?.state === "refund-only" && <p className="muted" style={{ fontSize: 12 }}>Returning to your private balance: the escrow re-shields as your pre-committed note after {new Date(order.params.refundAfter * 1000).toLocaleString()}; it is added to your private balance when the executor reports it (a rescan finds it too).</p>}
          {refundLine && <p className="muted" style={{ fontSize: 12 }}>{refundLine}</p>}
        </div>
      )}
    </div>
  );
}
