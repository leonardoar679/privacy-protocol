import { useState } from "react";
import type { Address } from "viem";
import { groupAddress, CHAIN_NAMES } from "@privacy-wallet/protocol/wallet/destinations";
import { bucketsFor } from "@privacy-wallet/protocol/wallet/amounts";
import { atLeast, type Tier } from "@privacy-wallet/protocol/wallet/valuation";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { assetsOf, formatAmount } from "@privacy-wallet/sdk/assets";
import { privateWithdrawal } from "@privacy-wallet/sdk/privateTx";
import { assertSecondFactor, verifyPassword, webauthnAvailable } from "@privacy-wallet/sdk/secondFactor";
import { addAddress, approveAddress, challengeMessage, destinationCheck, methodsFor, overrideCoolingOff, relabelAddress, retireAddress, verifyAddress, verifySignedChallenge, type AddressBookEntry, type AddressChain, type VerificationMethod } from "@privacy-wallet/sdk/wallet/addressBook";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { HoldButton } from "@privacy-wallet/ui";
import { exactOutput } from "@privacy-wallet/protocol/wallet/fees";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { demandScan } from "@privacy-wallet/sdk/wallet/discovery";
import { useFeeTerms } from "../../features/fees/useFeeTerms";
import { holdMs } from "@privacy-wallet/sdk/tiers";
import { classify } from "@privacy-wallet/sdk/operations/errors/catalog";
import { useAddressBook, useSettings } from "../../hooks";
import { useT } from "../../app/i18n/useT";
import type { MessageKey } from "../../app/i18n/en";
import { destinationStatusWords, destinationWords } from "../../features/destinationWords";

// The address book on the screens (High-Value Protection spec §12; plan V3 §35–§40, §126–§128): the Settings panel
// (every entry with its chain, label, lifecycle and status; add, verify, retire), the inline status under a typed
// destination on Swap and Withdraw with the way forward (add, verify, confirm an immediate use), the four verification
// methods — derived (fresh addresses, by construction), the grouped address re-typed, a signed message the wallet checks
// offline, a test transaction with its public-metadata warning — and the Immediate override: the typed phrase, the second
// factor (the separate device at institutional), the hold; all journaled, nothing sent anywhere. Every word comes from the
// message catalog (audit round 2, r55): these are the safety steps of a large payment, and a Korean reader had read them in
// English. The phrase an immediate use types stays as it is, like the words other confirmations compare.
/** The operations that paid an entry: a campaign step's reservation of its fresh address (`step:…`, until its order takes it over) pays nothing (the twelfth review round, ZM's critique). */
const paidBy = (e: AddressBookEntry): string[] => e.usedBy.filter((by) => !by.startsWith("step:"));
const LIFECYCLE_WORDS: Record<AddressBookEntry["lifecycle"], MessageKey> = { generated: "book.lifecycle.generated", verified: "book.lifecycle.verified", approved: "book.lifecycle.approved", used: "book.lifecycle.used", settled: "book.lifecycle.settled", retired: "book.lifecycle.retired" };
const METHOD_WORDS: Record<VerificationMethod, MessageKey> = { derived: "book.method.derived", "groups-read": "book.method.groups-read", "signed-message": "book.method.signed-message", "test-transaction": "book.method.test-transaction" };
export const OVERRIDE_PHRASE = "I ACCEPT THE RISK";

/** A fresh address's label is written when it is reserved (sdk recordFreshAddress), in English: said in the reader's words. */
function labelWords(t: ReturnType<typeof useT>, e: AddressBookEntry): string {
  const m = e.source === "fresh" ? /^Fresh address #(\d+)$/.exec(e.label) : null;
  return m ? t("book.freshLabel", { n: m[1] }) : e.label;
}

function chainOfEntry(e: AddressBookEntry): string { return CHAIN_NAMES[e.chain]; }

/** The grouped address re-typed group by group (§12 groups-read): every group must match. */
function GroupsRead({ entry, onVerified }: { entry: AddressBookEntry; onVerified: () => void }) {
  const t = useT();
  const groups = groupAddress(entry.normalized).replace(/^0x/, "").split(" ");
  const [typed, setTyped] = useState<string[]>(() => groups.map(() => ""));
  const [checked, setChecked] = useState<null | boolean>(null);
  const matches = typed.every((t, i) => t.trim().toLowerCase() === groups[i].toLowerCase());
  return (
    <div data-testid="verify-groups">
      <p className="muted small">{t(entry.normalized.startsWith("0x") ? "dest.groups.hint0x" : "dest.groups.hint", { n: groups.length, size: groups[0].length })}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {groups.map((g, i) => <input key={i} value={typed[i]} onChange={(e: any) => { const next = [...typed]; next[i] = e.target.value; setTyped(next); setChecked(null); }} style={{ width: 64, margin: 0 }} maxLength={g.length} autoComplete="off" data-testid={`group-${i}`} />)}
      </div>
      <div className="tabs" style={{ margin: "8px 0 0" }}>
        <button className="primary" onClick={() => { setChecked(matches); if (matches) onVerified(); }} disabled={typed.some((t) => !t)} data-testid="verify-groups-check">{t("dest.groups.check")}</button>
      </div>
      {checked === false && <p className="error small">{t("dest.groups.differ")}</p>}
    </div>
  );
}

/** A signed message (§12): the address proves control by signing the dated challenge; the wallet checks the signature offline. */
function SignedMessage({ entry, onVerified }: { entry: AddressBookEntry; onVerified: () => void }) {
  const t = useT();
  const [at] = useState(() => Date.now());
  const message = challengeMessage(entry, at);
  const [hintBefore, hintAfter] = t(entry.chain === "evm" ? "dest.signed.hintEvm" : "dest.signed.hintSolana").split("{method}");
  const [signature, setSignature] = useState("");
  const [result, setResult] = useState<null | boolean>(null);
  const [busy, setBusy] = useState(false);
  async function check() {
    setBusy(true);
    try { const ok = await verifySignedChallenge(entry, message, signature); setResult(ok); if (ok) onVerified(); } finally { setBusy(false); }
  }
  return (
    <div data-testid="verify-signed">
      {/* the signing method's name and the exact text to sign: never translated */}
      <p className="muted small">{hintBefore}<code translate="no">{entry.chain === "evm" ? "personal_sign / EIP-191" : "ed25519"}</code>{hintAfter}</p>
      <pre className="small" style={{ whiteSpace: "pre-wrap", padding: 8, border: "1px solid var(--border)", borderRadius: 8 }} translate="no" data-testid="challenge">{message}</pre>
      <input value={signature} onChange={(e: any) => { setSignature(e.target.value); setResult(null); }} placeholder={t(entry.chain === "evm" ? "dest.signed.placeholderEvm" : "dest.signed.placeholderSolana")} autoComplete="off" data-testid="signature-input" />
      <div className="tabs" style={{ margin: 0 }}><button className="primary" onClick={check} disabled={!signature || busy} data-testid="verify-signed-check">{t("dest.signed.check")}</button></div>
      {result === false && <p className="error small">{t("dest.signed.wrong")}</p>}
    </div>
  );
}

/** A test transaction (§12): the smallest common piece sent first, with the warning that it creates public metadata. */
function TestTransaction({ entry, masterSeed, deployment, onVerified }: { entry: AddressBookEntry; masterSeed: Uint8Array; deployment: Deployment | null; onVerified: () => void }) {
  const t = useT();
  const asset = assetsOf(deployment)[0];
  const piece = bucketsFor(asset.decimals)[0];
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  // what leaves the balance (the piece, the relayer's charge and the privacy fee), said before and paid no more (audit
  // round 2, r33): the test said "0.001 ETH" and took the relayer's charge and the privacy fee on top, whatever it asked by then
  const fees = useFeeTerms(asset.vault as Address);
  const split = fees.status === "ready" && fees.terms ? exactOutput(piece, fees.terms) : null;
  const ready = fees.status === "public" || (!!split && !split.tooSmall);
  async function send() {
    if (!deployment) { setStatus(t("dest.test.noDeployment")); return; }
    if (!ready) return;
    if (noteStore.balance(BigInt(asset.vault)) < (split?.total ?? piece)) { setStatus(t("dest.test.notEnough", { symbol: asset.symbol })); return; }
    setBusy(true);
    // the catalog's words, not the engine's English progress lines (audit round 2, r55)
    setStatus(t("dest.test.sending"));
    demandScan(); // a change note takes a counter: a scan the counters wait for is asked for now (the twelfth review round, W6 §5)
    try {
      // each merge it needs first at most the relayer's F read here (the seventh review round)
      const r = await privateWithdrawal({ masterSeed, deployment, amount: piece, recipient: entry.normalized as Address, vault: asset.vault, ...(split ? { maxFee: split.fee } : {}), ...(fees.status === "ready" && fees.terms ? { maxMergeFee: fees.terms.minimum } : {}) });
      setStatus(t("dest.test.sent", { amount: formatAmount(asset, piece), symbol: asset.symbol, hash: r.txHash.slice(0, 10) }));
      onVerified();
    } catch (e) { setStatus(t(`op.error.${classify(e).code}.reason` as MessageKey)); } finally { setBusy(false); }
  }
  return (
    <div data-testid="verify-test">
      <p className="notice small">{t("dest.test.warning")}</p>
      <p className="muted small" data-testid="verify-test-cost">
        {split
          ? t("dest.test.costFees", { amount: formatAmount(asset, piece), symbol: asset.symbol, address: groupAddress(entry.normalized), total: formatAmount(asset, split.total), fee: formatAmount(asset, split.fee) })
          : t("dest.test.cost", { amount: formatAmount(asset, piece), symbol: asset.symbol, address: groupAddress(entry.normalized) })}
      </p>
      <div className="tabs" style={{ margin: 0 }}><button className="primary" onClick={send} disabled={busy || !ready} data-testid="verify-test-send">{t("dest.test.send")}</button></div>
      {status && <p className="muted small">{status}</p>}
    </div>
  );
}

/** Verify an entry by one of its chain's methods. */
export function VerifyEntry({ entry, masterSeed, deployment, onDone }: { entry: AddressBookEntry; masterSeed: Uint8Array; deployment: Deployment | null; onDone?: () => void }) {
  const t = useT();
  const methods = methodsFor(entry.chain);
  const [method, setMethod] = useState<VerificationMethod>(methods[0]);
  const verified = (m: VerificationMethod) => { verifyAddress(entry.id, m); onDone?.(); };
  return (
    <div style={{ marginTop: 8 }} data-testid="verify-entry">
      <div className="segment" role="tablist" style={{ margin: "6px 0" }}>
        {methods.map((m) => <button key={m} className={method === m ? "active" : ""} onClick={() => setMethod(m)} data-method={m}>{t(m === "groups-read" ? "dest.method.groups" : m === "signed-message" ? "dest.method.signed" : "dest.method.test")}</button>)}
      </div>
      {method === "groups-read" && <GroupsRead entry={entry} onVerified={() => verified("groups-read")} />}
      {method === "signed-message" && <SignedMessage entry={entry} onVerified={() => verified("signed-message")} />}
      {method === "test-transaction" && <TestTransaction entry={entry} masterSeed={masterSeed} deployment={deployment} onVerified={() => verified("test-transaction")} />}
    </div>
  );
}

/** The Immediate override (§12): the typed phrase, the hold, then the second factor — the separate device at institutional, with no password fallback there. */
export function OverridePanel({ entry, tier, onDone }: { entry: AddressBookEntry; tier: Tier; onDone?: () => void }) {
  const t = useT();
  const { secondFactor, protection } = useSettings();
  const [phrase, setPhrase] = useState("");
  const [step, setStep] = useState<"idle" | "password" | "done">("idle");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const institutional = tier === "institutional";
  async function confirmed() {
    setError("");
    if (institutional) {
      // the separate device, no password fallback
      const id = protection.secondDevice.credentialId;
      if (!id || !webauthnAvailable()) { setError(t("dest.override.noDevice")); return; }
      if (!(await assertSecondFactor(id))) { setError(t("dest.override.deviceDeclined")); return; }
      overrideCoolingOff(entry.id, "second-device"); setStep("done"); onDone?.(); return;
    }
    if (secondFactor.credentialId && webauthnAvailable() && (await assertSecondFactor(secondFactor.credentialId))) { overrideCoolingOff(entry.id, "second-factor"); setStep("done"); onDone?.(); return; }
    setStep("password");
  }
  async function withPassword() {
    setError("");
    if (!(await verifyPassword(password))) { setError(t("review.factor.wrongPassword")); return; }
    setPassword(""); overrideCoolingOff(entry.id, "second-factor"); setStep("done"); onDone?.();
  }
  if (step === "done") return <p className="muted small" data-testid="override-done">{t("dest.override.done")}</p>;
  // the sentence around the phrase (`{phrase}` left in the template), the phrase itself as it is typed
  const [before, after] = t(institutional ? "dest.override.introDevice" : "dest.override.intro").split("{phrase}");
  return (
    <div className="notice" style={{ marginTop: 8 }} data-testid="override-panel">
      <div className="small">{before}<b translate="no">{OVERRIDE_PHRASE}</b>{after}</div>
      <input value={phrase} onChange={(e: any) => setPhrase(e.target.value)} placeholder={OVERRIDE_PHRASE} autoComplete="off" data-testid="override-phrase" />
      {step === "idle" && <HoldButton label={t("dest.override")} holdMs={holdMs()} onConfirm={confirmed} disabled={phrase.trim() !== OVERRIDE_PHRASE} />}
      {step === "password" && (
        <div data-testid="override-password">
          <div className="small">{t(secondFactor.credentialId ? "dest.override.passwordDeclined" : "dest.override.passwordNone")}</div>
          <input type="password" value={password} onChange={(e: any) => setPassword(e.target.value)} onKeyDown={(e: any) => { if (e.key === "Enter") withPassword(); }} autoComplete="current-password" />
          <button className="primary" onClick={withPassword} disabled={!password}>{t("review.factor.confirmWithPassword")}</button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** Under a typed destination (Swap, Withdraw): the status against the book and the way forward. */
export function DestinationStatus({ chain, address, tier, masterSeed, deployment, asset }: { chain: AddressChain; address: string; tier: Tier; masterSeed: Uint8Array; deployment: Deployment | null; asset?: string }) {
  const t = useT();
  useAddressBook(); // re-render on every journal write
  const [open, setOpen] = useState<null | "verify" | "override">(null);
  const check = destinationCheck(chain, address, { tier });
  const large = atLeast(tier, "high-value");
  const entry = check.entry;
  return (
    <div className="small" style={{ margin: "-4px 0 10px" }} data-testid="destination-status" data-ok={check.ok ? "1" : "0"} data-reason={check.reason ?? ""}>
      <span className={check.ok ? "muted" : "level-Reduced"}>{destinationStatusWords(t, check)}</span>
      <span className="tabs" style={{ margin: "4px 0 0", display: "inline-flex" }}>
        {!entry && <button className="tab" onClick={() => { const r = addAddress({ chain, address, asset }); if (r.ok) setOpen("verify"); }} data-testid="add-to-book">{t("dest.add")}</button>}
        {entry && (entry.verification.status !== "verified" || check.reason === "stale") && <button className="tab" onClick={() => setOpen(open === "verify" ? null : "verify")} data-testid="verify-destination">{t(check.reason === "stale" ? "dest.checkAgain" : "dest.verify")}</button>}
        {entry && check.reason === "cooling-off" && large && <button className="tab" onClick={() => setOpen(open === "override" ? null : "override")} data-testid="override-destination">{t("dest.override")}</button>}
        {entry && check.reason === "unapproved" && <button className="tab" onClick={() => approveAddress(entry.id)} data-testid="approve-destination">{t("dest.approve")}</button>}
      </span>
      {open === "verify" && entry && (entry.verification.status !== "verified" || check.reason === "stale") && <VerifyEntry entry={entry} masterSeed={masterSeed} deployment={deployment} onDone={() => setOpen(null)} />}
      {open === "override" && entry && <OverridePanel entry={entry} tier={tier} onDone={() => setOpen(null)} />}
    </div>
  );
}

/** Settings → Address book: every entry, add, verify, label, retire. */
export function AddressBookPanel({ deployment }: { deployment: Deployment | null }) {
  const t = useT();
  const entries = useAddressBook();
  const masterSeed = session.state().seed;
  const [chain, setChain] = useState<AddressChain>("evm");
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [verifying, setVerifying] = useState<string | null>(null);
  const now = Date.now();
  function add() {
    const r = addAddress({ chain, address, label });
    if (!r.ok) { setError(destinationWords(t, r)); return; }
    setError(""); setAddress(""); setLabel(""); setVerifying(r.entry.id);
  }
  return (
    <div className="panel" data-testid="address-book">
      <h3>{t("common.addressBook")}</h3>
      <p className="muted small">{t("book.intro")}</p>
      {entries.length === 0 && <p className="muted small">{t("book.empty")}</p>}
      {entries.map((e) => {
        const check = destinationCheck(e.chain, e.normalized, { tier: "high-value", now });
        return (
          <div key={e.id} className="list-row" style={{ alignItems: "flex-start" }} data-testid="book-entry" data-lifecycle={e.lifecycle} data-source={e.source}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div><b>{labelWords(t, e) || t("book.noLabel")}</b> <span className="muted small">· {chainOfEntry(e)} · {t(e.source === "fresh" ? "book.source.fresh" : "book.source.entered")} · {t(LIFECYCLE_WORDS[e.lifecycle])}{e.verification.method ? ` · ${t(METHOD_WORDS[e.verification.method])}` : ""}{paidBy(e).length ? ` · ${t("book.paidBy", { n: paidBy(e).length, plural: paidBy(e).length === 1 ? "" : "s" })}` : ""}</span></div>
              <code className="small" style={{ wordBreak: "break-all" }} translate="no">{groupAddress(e.address)}</code>
              <div className={check.ok ? "muted small" : "small level-Reduced"}>{destinationStatusWords(t, check, now)}</div>
              {verifying === e.id && (e.verification.status !== "verified" || check.reason === "stale") && masterSeed && <VerifyEntry entry={e} masterSeed={masterSeed} deployment={deployment} onDone={() => setVerifying(null)} />}
            </div>
            <div className="tabs" style={{ margin: 0, flexDirection: "column", alignItems: "flex-end" }}>
              {e.verification.status !== "verified" && e.lifecycle !== "retired" && <button className="tab" onClick={() => setVerifying(verifying === e.id ? null : e.id)}>{t("dest.verify")}</button>}
              {e.source === "entered" && check.reason === "unapproved" && <button className="tab" onClick={() => approveAddress(e.id)} data-testid="approve-entry">{t("dest.approve")}</button>}
              {e.source === "entered" && check.reason === "stale" && <button className="tab" onClick={() => setVerifying(verifying === e.id ? null : e.id)} data-testid="recheck-entry">{t("dest.checkAgain")}</button>}
              {e.source === "entered" && e.lifecycle !== "retired" && <button className="tab" onClick={() => { const l = prompt(t("book.label"), e.label); if (l !== null) relabelAddress(e.id, l); }}>{t("book.label")}</button>}
              {e.lifecycle !== "retired" && <button className="tab" onClick={() => retireAddress(e.id)} data-testid="retire-entry">{t("book.retire")}</button>}
            </div>
          </div>
        );
      })}
      <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
        <label htmlFor="book-chain">{t("book.addTitle")}</label>
        <select id="book-chain" value={chain} onChange={(e: any) => setChain(e.target.value)} data-testid="book-chain">
          <option value="evm">{t("book.chain.evm")}</option>
          <option value="bitcoin">Bitcoin</option>
          <option value="solana">Solana</option>
        </select>
        <input value={address} onChange={(e: any) => setAddress(e.target.value)} placeholder={t("book.addressPlaceholder")} autoComplete="off" data-testid="book-address" />
        <input value={label} onChange={(e: any) => setLabel(e.target.value)} placeholder={t("book.labelPlaceholder")} autoComplete="off" data-testid="book-label" />
        {error && <p className="error small">{error}</p>}
        <button className="tab" onClick={add} disabled={!address.trim()} data-testid="book-add">{t("book.add")}</button>
      </div>
    </div>
  );
}
