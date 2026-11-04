import { useEffect, useRef, useState } from "react";
import { formatEther, parseEther } from "viem";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { privateWithdrawal } from "@privacy-wallet/sdk/privateTx";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { exactOutput } from "@privacy-wallet/protocol/wallet/fees";
import { useFeeTerms } from "../features/fees/useFeeTerms";
import { Scorecard } from "./Scorecard";
import { deriveFundingKey, freshAccountProvider } from "../zkapi/freshAccountProvider";
import { creditWalletProvider, fundingChainOk, refusingProvider, revocableProvider } from "../zkapi/creditWallet";
import { aiSession, endAiSession } from "../zkapi/aiSession";
import { ADDRESS_LIKE, looksLikePhrase } from "../zkapi/tradeCheck";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { isBucketOf } from "@privacy-wallet/protocol/wallet/amounts";
import { wordlist } from "@scure/bip39/wordlists/english";
import { CHAT_SPENDING_TIER_USD, chatStream, configureZkapi, zkapiBundled, listModels, loadBrowserConfig, loadPinCheck, newSessionId, zkapiClient, zkapiEnabled, type BrowserConfig, type ChatMessage, type InferenceAccess, type PinCheck, type TestnetPasswordRequest } from "../zkapi/sdk";

// Private AI (plan §4, §63): one private credit account (zkAPI, native ETH, expiring service credit)
// pays for inference with short-lived provider keys. Funding comes from a FRESH wallet-derived
// address (spec §4), itself funded by a private withdrawal from the pool (spec §6) — so neither the
// billing server nor the provider ever sees the permanent address, and the pool never sees zkAPI.
const DEFAULT_MODELS = ["openai/gpt-4o-mini", "anthropic/claude-3.5-haiku", "google/gemini-flash-1.5", "meta-llama/llama-3.1-8b-instruct"];
const CREDIT_BUCKETS_ETH = ["0.005", "0.01", "0.02"]; // spec §4: small, expiring credit per note (high privacy ≤ 0.005, default ≤ 0.02)
const FEE_RESERVE_ETH = "0.0005"; // gas for the deposit (and later the withdrawal) paid by the fresh address

interface PasswordDialog extends TestnetPasswordRequest { resolve: () => void; reject: (e: Error) => void; error: string }

/** The SDK's own word that its service answers (C-M1): nothing is funded for a credit the SDK could not deposit. */
const serviceAvailable = (snapshot: any): boolean => snapshot?.config?.service?.available === true;
/** A lock ends the SDK's hold on the fresh funding key (the eighth review round, C-M2): its timers kept a provider that could sign. */
let lockHooked = false;

/** The build without the zkAPI SDK clone (V6 Stage 2: CI, a fresh checkout) says so instead of failing on first use. */
export function PrivateAI(props: { masterSeed: Uint8Array; deployment: Deployment | null }) {
  if (!zkapiBundled) return <p className="muted" data-testid="private-ai-unavailable">Private AI is not included in this build: the zkAPI SDK clone was not present when it was built.</p>;
  return <PrivateAIScreen {...props} />;
}

function PrivateAIScreen({ masterSeed, deployment }: { masterSeed: Uint8Array; deployment: Deployment | null }) {
  const [pin, setPin] = useState<PinCheck | null | undefined>(undefined);
  const [cfg, setCfg] = useState<BrowserConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [snapshot, setSnapshot] = useState<any>(null);
  // the fresh funding address index lives in the encrypted journal (V2 Stage 9): a withdrawn credit note moves to the next, across reloads
  const [fundingIndex, setFundingIndex] = useState(() => (session.isUnlocked() ? session.journal().aiFunding?.index ?? 0 : 0));
  const [fundingMode, setFundingMode] = useState<"fresh" | "connected">("fresh");
  const [bucket, setBucket] = useState(CREDIT_BUCKETS_ETH[1]);
  // the pool funding's relayer charge and privacy fee, said on the button, counted and bounded (audit round 2, r33): the
  // button named the credit and the reserve only, and the withdrawal paid the fees on top, whatever the relayer asked by then
  const fees = useFeeTerms(fundingMode === "fresh" && deployment ? deployment.ethVault : null);
  const funding = fees.status === "ready" && fees.terms ? exactOutput(parseEther(bucket) + parseEther(FEE_RESERVE_ETH), fees.terms) : null;
  const fundingReady = fees.status === "public" || (!!funding && !funding.tooSmall);
  const [models, setModels] = useState<{ id: string; name: string }[]>(DEFAULT_MODELS.map((id) => ({ id, name: id })));
  const [model, setModel] = useState(DEFAULT_MODELS[0]);
  const [tier, setTier] = useState<number>(Number(CHAT_SPENDING_TIER_USD?.[0] ?? 1));
  const [access, setAccess] = useState<InferenceAccess | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [pw, setPw] = useState<PasswordDialog | null>(null);
  const [pwValue, setPwValue] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    loadPinCheck().then(setPin);
    loadBrowserConfig().then(setCfg);
  }, []);

  const fresh = deriveFundingKey(masterSeed, fundingIndex);
  const ok = zkapiEnabled(pin ?? null);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true); setStatus(label);
    try { await fn(); } catch (e: any) { setStatus(e?.message ?? String(e)); } finally { setBusy(false); }
  }

  // The Sepolia server's shared testnet password (sdk/README.md): the SDK calls this when it needs one;
  // the form stays open on a rejected password, resolves after validation, rejects on dismissal.
  // Nothing is logged or persisted.
  const requestTestnetPassword = (req: TestnetPasswordRequest) => new Promise<void>((resolve, reject) => setPw({ ...req, resolve, reject, error: "" }));
  async function submitPassword() {
    if (!pw) return;
    try {
      await pw.authenticate(pwValue, { signal: pw.signal });
      pw.resolve();
      setPw(null); setPwValue("");
    } catch (e: any) {
      setPw({ ...pw, error: e?.message ?? "password rejected" });
    }
  }
  function cancelPassword() {
    pw?.reject(new Error("testnet password dialog dismissed"));
    setPw(null); setPwValue("");
  }

  async function enable() {
    await run("Initializing the private credit wallet…", async () => {
      configureZkapi({ requestTestnetPassword });
      if (fundingMode === "fresh" && !cfg) throw new Error("browser-config.json not loaded");
      // the lease ends with a lock (never one key across two sessions or wallets) — registered before anything else (the ninth review round,
      // B-I4: after a failed init the provider had been set with no hook)
      if (!lockHooked) {
        lockHooked = true;
        session.onLock(() => endAiSession());
      }
      // the connected wallet is the one the connection chose; its address funds the credit (not private). The provider answers only while
      // this session stays open (B-F2/F3): a lock revokes it, whatever the SDK is doing — never swapped for the user's public wallet
      const epoch = session.epoch();
      const provider = creditWalletProvider(fundingMode, () => freshAccountProvider(fresh.privateKey, cfg!.trusted_deployment.rpc_url, Number(cfg!.trusted_deployment.chain_id)));
      zkapiClient.setWalletProvider(revocableProvider(provider ?? refusingProvider, () => session.isUnlocked() && session.epoch() === epoch));
      await zkapiClient.init();
      zkapiClient.subscribe((s: any) => setSnapshot(s));
      setSnapshot(zkapiClient.snapshot());
      setEnabled(true);
      setStatus("Private credit wallet ready.");
      listModels().then((all) => { if (all.length) setModels(all); }).catch(() => {});
    });
  }

  async function fundFromPool() {
    if (!deployment) { setStatus("No pool deployment configured (VITE_RPC_URL / VITE_CORE / VITE_ETH_VAULT)."); return; }
    // the credit's deployment on the pool's chain only (audit round 2, p03)
    if (!fundingChainOk(deployment.chainId, cfg)) { setStatus(`Private AI's deployment is on chain ${cfg?.trusted_deployment.chain_id ?? "unknown"}, the pool on chain ${deployment.chainId}: nothing was sent.`); return; }
    const total = parseEther(bucket) + parseEther(FEE_RESERVE_ETH);
    if (!fundingReady) return;
    // the SDK's service answers before any pool money moves (the eighth review round, C-M1): a credit it could not deposit had been funded
    if (!serviceAvailable(snapshot)) { setStatus("The private credit service is not answering right now: nothing was funded."); return; }
    // one funding per fresh address (C-L2): a second, after a failed deposit or a reload, had linked two pool withdrawals by their recipient
    if (session.isUnlocked() && session.journal().aiFunding?.funded === fundingIndex) { setStatus(`Funding address #${fundingIndex} is already funded: deposit its credit, or withdraw it first.`); return; }
    const leaves = funding?.total ?? total;
    if (noteStore.balance(BigInt(deployment.ethVault)) < leaves) { setStatus(`Not enough shielded ETH: ${formatEther(leaves)} ETH leaves your balance (${bucket} + ${FEE_RESERVE_ETH} fee reserve${funding ? ` + ${formatEther(funding.fee)} relayer and privacy fees` : ""}).`); return; }
    await run("Private withdrawal from the pool to the fresh funding address…", async () => {
      // each merge it needs first at most the relayer's F read here (the seventh review round: the merges had paid the live fee, unbounded)
      // journaled as soon as it is sent (the ninth review round, B-F7): a withdrawal that failed after its submission had left no mark, and a
      // second funding of the same address was allowed — the link C-L2 closes
      const markFunded = () => session.update((j) => { j.aiFunding = { index: fundingIndex, funded: fundingIndex }; });
      const r = await privateWithdrawal({ masterSeed, deployment, amount: total, recipient: fresh.address, ...(funding ? { maxFee: funding.fee } : {}), ...(fees.status === "ready" && fees.terms ? { maxMergeFee: fees.terms.minimum } : {}), onStatus: setStatus, onEvent: (e) => { if (e.type === "submitting") markFunded(); } });
      markFunded(); // journaled: never funded twice (C-L2)
      setStatus(`Fresh address ${fresh.address.slice(0, 10)}… funded with ${formatEther(total)} ETH (tx ${r.txHash.slice(0, 10)}…). Now deposit the credit.`);
    });
  }

  async function depositCredit() {
    await run("Preparing the zkAPI deposit…", async () => {
      if (fundingMode === "fresh") {
        const prepared = await zkapiClient.prepareDepositQuote(bucket, { from: fresh.address });
        setStatus(`Depositing ${bucket} ETH as private credit (commitment ${String(prepared.commitment).slice(0, 12)}…)…`);
        await zkapiClient.deposit(bucket, (m: string) => setStatus(String(m)), { preparedOperationId: prepared.operationId });
      } else {
        await zkapiClient.deposit(bucket, (m: string) => setStatus(String(m)));
      }
      setStatus(`Credit note funded with ${bucket} ETH. It expires in 30 days: withdraw unused credit before then.`);
    });
  }

  async function startSession() {
    await run("Proving the credit and requesting a short-lived provider key…", async () => {
      const a: InferenceAccess = await zkapiClient.acquireInferenceAccess(newSessionId(), { spendingLimitUsd: tier, onProgress: (p: any) => setStatus(String(p?.message ?? p?.phase ?? "")) });
      setAccess(a);
      aiSession.set(a, model); // the Review screen's "Check this trade" uses this session (it signs nothing)
      setMessages([]);
      setStatus(`Private chat ready: cap $${a.spendingLimitUsd}, key for ${new URL(a.baseUrl).host} only.`);
    });
  }

  function endSession() {
    abortRef.current?.abort();
    access?.release();
    setAccess(null);
    aiSession.set(null);
    setStatus("Session ended; the key retires and only actual usage is settled.");
  }

  async function send() {
    if (!access || !input.trim()) return;
    // nothing that looks like an address, a hash or a note leaves for the provider (the fourth review round, 2026-11-03): the trade
    // check already refuses such values; a typed or pasted one in the free text had gone out as it was
    if (ADDRESS_LIKE.test(input) || looksLikePhrase(input, wordlist)) {
      // a recovery phrase too (the eighth review round, C-L4): pasted "to check it", 24 words had gone to the provider
      setStatus("Not sent: the message carries something that looks like an address, a transaction hash, a note or a recovery phrase. Remove it first — nothing of yours should reach the provider.");
      return;
    }
    const next: ChatMessage[] = [...messages, { role: "user", content: input.trim() }];
    setMessages([...next, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      let text = "";
      for await (const chunk of chatStream(access, model, next, ctrl.signal)) {
        text += chunk;
        setMessages([...next, { role: "assistant", content: text }]);
      }
    } catch (e: any) {
      setMessages([...next, { role: "assistant", content: `[error] ${e?.message ?? e}` }]);
    } finally {
      setBusy(false);
    }
  }

  async function withdrawCredit() {
    await run("Closing the credit note (mutual close)…", async () => {
      // back to where it came from (the eighth review round, C-L2): the connected account in connected mode — the close is sent from it
      // anyway — never a fresh address that mode never showed and no screen spends from
      // in connected mode the SDK pays the account it connects itself (the ninth review round, B-F8): the address it knew was reset by every
      // Enable, and the withdrawal had been refused after any reload
      await zkapiClient.withdraw("mutual", (m: string) => setStatus(String(m)), fundingMode === "fresh" ? { destination: fresh.address } : {});
      setStatus(fundingMode === "fresh" ? `Credit withdrawn to the fresh address ${fresh.address.slice(0, 10)}…; shield it back into the pool from there.` : "Credit withdrawn to the connected account.");
      setFundingIndex((i) => { session.update((j) => { j.aiFunding = { index: i + 1 }; }); return i + 1; }); // the next credit note gets a new fresh address, journaled
    });
  }

  const note = snapshot?.wallet?.note ?? zkapiClient?.note ?? null;

  return (
    <div className="panel">
      <h3>Private AI</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        Pay for inference from a private credit account (zkAPI, native ETH). Runtime-key mode only: your prompt goes straight to the provider with a short-lived key; the billing server sees a proof, never the prompt. Service credit expires (30 d); pool money never does.
      </p>

      <div className="row"><span className="muted">Deployment pins (checked at build)</span>
        <b>{pin === undefined ? "…" : pin === null ? "no pin-check.json — run npm run zkapi:assets && npm run zkapi:pins" : ok ? `${pin.network} · ${pin.pass} checks + lab ${pin.lab.pass} ✔ · ${new Date(pin.checkedAt).toLocaleDateString()}` : `FAILED (${pin.fail}) — zkAPI disabled`}</b></div>
      {pin && <div className="muted" style={{ fontSize: 12 }}>{pin.deploymentId} · vault {pin.vault.slice(0, 10)}… · {pin.circuit} · {pin.protocolServer}</div>}

      {pw && (
        <div className="panel" style={{ marginTop: 10 }}>
          <label>Sepolia testnet password (the shared password of the test billing server; never stored)</label>
          <input type="password" value={pwValue} onChange={(e: any) => setPwValue(e.target.value)} onKeyDown={(e: any) => { if (e.key === "Enter") submitPassword(); }} />
          {pw.error && <p style={{ color: "var(--warn)" }}>{pw.error}</p>}
          <div className="tabs">
            <button className="primary" onClick={submitPassword} disabled={!pwValue}>Submit</button>
            <button className="tab" onClick={cancelPassword}>Cancel</button>
          </div>
        </div>
      )}

      {!enabled ? (
        <>
          <label>Funding address</label>
          <select value={fundingMode} onChange={(e: any) => setFundingMode(e.target.value)}>
            <option value="fresh">Fresh wallet-derived address (private; funded from the pool)</option>
            <option value="connected">Connected wallet address (not private: links the credit to your public address)</option>
          </select>
          {fundingMode === "fresh" && <div className="muted" style={{ fontSize: 12 }}>Funding address #{fundingIndex}: <code>{fresh.address}</code></div>}
          <button className="primary" onClick={enable} disabled={!ok || busy}>Enable private AI</button>
        </>
      ) : (
        <>
          <div className="row"><span className="muted">Credit note</span><b>{note ? `${note.balance !== undefined ? zkapiClient.formatBillingAmount(note.balance) + " ETH" : "active"}${note.expires_at ? ` · expires ${new Date(Number(note.expires_at) * 1000).toLocaleDateString()}` : ""}` : "none yet"}</b></div>
          <div className="row"><span className="muted">Funding address</span><code>{fundingMode === "fresh" ? fresh.address : snapshot?.walletAddress ?? "connected wallet"}</code></div>
          {pin?.network === "sepolia" && <div className="row"><span className="muted">Testnet access</span><b>{zkapiClient.testnetAuthenticated ? "authenticated" : "password required on first use"}</b></div>}
          <label>Credit amount (bucket)</label>
          <select value={bucket} onChange={(e: any) => setBucket(e.target.value)}>
            {CREDIT_BUCKETS_ETH.map((b) => <option key={b} value={b}>{b} ETH</option>)}
          </select>
          <div className="tabs" style={{ marginTop: 8 }}>
            {fundingMode === "fresh" && <button className="tab" onClick={fundFromPool} disabled={busy || !fundingReady || !serviceAvailable(snapshot)}>1 · Fund the fresh address from the pool ({funding ? `${formatEther(funding.total)} ETH with the relayer and privacy fees` : `${bucket} + ${FEE_RESERVE_ETH} ETH`})</button>}
            <button className="tab" onClick={depositCredit} disabled={busy}>{fundingMode === "fresh" ? "2 · " : ""}Deposit {bucket} ETH as credit</button>
            <button className="tab" onClick={withdrawCredit} disabled={busy || !note}>Withdraw unused credit</button>
          </div>

          <label>Model</label>
          <input list="zkapi-models" value={model} onChange={(e: any) => setModel(e.target.value)} />
          <datalist id="zkapi-models">{models.slice(0, 200).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
          <label>Spending cap for this session (USD)</label>
          <select value={tier} onChange={(e: any) => setTier(Number(e.target.value))}>
            {(CHAT_SPENDING_TIER_USD ?? [1, 2, 3, 4.5, 6]).map((t: number) => <option key={t} value={t}>${t}</option>)}
          </select>
          <div className="tabs" style={{ marginTop: 8 }}>
            {!access ? <button className="primary" onClick={startSession} disabled={busy || !note}>Start private chat</button> : <button className="tab" onClick={endSession}>End session</button>}
          </div>

          {access && (
            <div style={{ marginTop: 12 }}>
              {messages.map((m, i) => (
                <div key={i} style={{ padding: "6px 0", borderTop: "1px solid var(--border)" }}>
                  <span className="muted" style={{ fontSize: 12 }}>{m.role}</span>
                  <div style={{ whiteSpace: "pre-wrap" }}>{m.content || (busy && i === messages.length - 1 ? "…" : "")}</div>
                </div>
              ))}
              <label>Ask anything</label>
              <input value={input} onChange={(e: any) => setInput(e.target.value)} onKeyDown={(e: any) => { if (e.key === "Enter" && !busy) send(); }} placeholder="Your prompt goes to the provider only, with a key that cannot be linked to your deposit" />
              <button className="primary" onClick={send} disabled={busy || !input.trim()}>Send</button>
            </div>
          )}
        </>
      )}

      {/* the facts as they are (the eighth review round, C-L3): the pool withdrawal's amount (credit + reserve + fees) is no bucket, and a
          wallet submission sends it from the connected account */}
      <Scorecard action="credit" facts={{ delaySeconds: 0, amountIsBucket: isBucketOf(funding?.total ?? parseEther(bucket) + parseEther(FEE_RESERVE_ETH), 18), privateSubmission: settings.get().submission.kind === "relayer", rpcEndpoints: deployment?.rpcUrls?.length ?? 1, recipientFresh: fundingMode === "fresh", credit: { runtimeKey: true, freshFunding: fundingMode === "fresh" } }} />
      {status && <p className="muted">{status}</p>}
      {snapshot && (
        <>
          <button className="tab" onClick={() => setShowDetails((v) => !v)} style={{ marginTop: 8 }}>{showDetails ? "Hide" : "Show"} credit-wallet details</button>
          {showDetails && <pre className="muted" style={{ fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{JSON.stringify({ initialized: snapshot.initialized, loading: snapshot.loading, lastError: snapshot.lastError, deposits: snapshot.deposits?.length, withdrawals: snapshot.withdrawals?.length, activities: snapshot.activities?.slice(-3), testnetAuthenticated: zkapiClient.testnetAuthenticated }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}</pre>}
        </>
      )}
      <p className="muted" style={{ fontSize: 12 }}>
        The credit wallet's journal lives in this origin's IndexedDB (the SDK's design); the funding key is derived from your seed and never stored. Expiring credit: keep notes small and withdraw before day 30.
      </p>
    </div>
  );
}
