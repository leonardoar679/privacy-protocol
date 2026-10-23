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
import { useFeeTerms } from "../../features/fees/useFeeTerms";
import { holdMs } from "@privacy-wallet/sdk/tiers";
import { useAddressBook, useSettings } from "../../hooks";

// The address book on the screens (High-Value Protection spec §12; plan V3 §35–§40, §126–§128): the Settings panel
// (every entry with its chain, label, lifecycle and status; add, verify, retire), the inline status under a typed
// destination on Swap and Withdraw with the way forward (add, verify, confirm an immediate use), the four verification
// methods — derived (fresh addresses, by construction), the grouped address re-typed, a signed message the wallet checks
// offline, a test transaction with its public-metadata warning — and the Immediate override: the typed phrase, the second
// factor (the separate device at institutional), the hold; all journaled, nothing sent anywhere.
const LIFECYCLE_WORDS: Record<AddressBookEntry["lifecycle"], string> = { generated: "added", verified: "verified", approved: "approved for large payments", used: "in use", settled: "paid", retired: "retired" };
const METHOD_WORDS: Record<VerificationMethod, string> = { derived: "derived by this wallet", "groups-read": "re-typed group by group", "signed-message": "a signed message", "test-transaction": "a test transaction" };
export const OVERRIDE_PHRASE = "I ACCEPT THE RISK";

function chainOfEntry(e: AddressBookEntry): string { return CHAIN_NAMES[e.chain]; }

/** The grouped address re-typed group by group (§12 groups-read): every group must match. */
function GroupsRead({ entry, onVerified }: { entry: AddressBookEntry; onVerified: () => void }) {
  const groups = groupAddress(entry.normalized).replace(/^0x/, "").split(" ");
  const [typed, setTyped] = useState<string[]>(() => groups.map(() => ""));
  const [checked, setChecked] = useState<null | boolean>(null);
  const matches = typed.every((t, i) => t.trim().toLowerCase() === groups[i].toLowerCase());
  return (
    <div data-testid="verify-groups">
      <p className="muted small">Re-type the address group by group, reading it from where you got it (not from this screen): {groups.length} groups of {groups[0].length}{entry.normalized.startsWith("0x") ? " after 0x" : ""}.</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {groups.map((g, i) => <input key={i} value={typed[i]} onChange={(e: any) => { const next = [...typed]; next[i] = e.target.value; setTyped(next); setChecked(null); }} style={{ width: 64, margin: 0 }} maxLength={g.length} autoComplete="off" data-testid={`group-${i}`} />)}
      </div>
      <div className="tabs" style={{ margin: "8px 0 0" }}>
        <button className="primary" onClick={() => { setChecked(matches); if (matches) onVerified(); }} disabled={typed.some((t) => !t)} data-testid="verify-groups-check">Check the groups</button>
      </div>
      {checked === false && <p className="error small">One or more groups differ from the address in the book. Compare them with the source before you continue.</p>}
    </div>
  );
}

/** A signed message (§12): the address proves control by signing the dated challenge; the wallet checks the signature offline. */
function SignedMessage({ entry, onVerified }: { entry: AddressBookEntry; onVerified: () => void }) {
  const [at] = useState(() => Date.now());
  const message = challengeMessage(entry, at);
  const [signature, setSignature] = useState("");
  const [result, setResult] = useState<null | boolean>(null);
  const [busy, setBusy] = useState(false);
  async function check() {
    setBusy(true);
    try { const ok = await verifySignedChallenge(entry, message, signature); setResult(ok); if (ok) onVerified(); } finally { setBusy(false); }
  }
  return (
    <div data-testid="verify-signed">
      <p className="muted small">Sign this exact text with the key of the destination ({entry.chain === "evm" ? "personal_sign / EIP-191" : "an ed25519 signature of the text"}) and paste the signature. Nothing is sent anywhere: the signature is checked here.</p>
      <pre className="small" style={{ whiteSpace: "pre-wrap", padding: 8, border: "1px solid var(--border)", borderRadius: 8 }} data-testid="challenge">{message}</pre>
      <input value={signature} onChange={(e: any) => { setSignature(e.target.value); setResult(null); }} placeholder={entry.chain === "evm" ? "0x… (65 bytes)" : "base58 or hex (64 bytes)"} autoComplete="off" data-testid="signature-input" />
      <div className="tabs" style={{ margin: 0 }}><button className="primary" onClick={check} disabled={!signature || busy} data-testid="verify-signed-check">Check the signature</button></div>
      {result === false && <p className="error small">The signature does not come from this address.</p>}
    </div>
  );
}

/** A test transaction (§12): the smallest common piece sent first, with the warning that it creates public metadata. */
function TestTransaction({ entry, masterSeed, deployment, onVerified }: { entry: AddressBookEntry; masterSeed: Uint8Array; deployment: Deployment | null; onVerified: () => void }) {
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
    if (!deployment) { setStatus("No deployment configured."); return; }
    if (!ready) return;
    if (noteStore.balance(BigInt(asset.vault)) < (split?.total ?? piece)) { setStatus(`Not enough ${asset.symbol} in your private balance for the test and its fees.`); return; }
    setBusy(true);
    try {
      const r = await privateWithdrawal({ masterSeed, deployment, amount: piece, recipient: entry.normalized as Address, vault: asset.vault, ...(split ? { maxFee: split.fee } : {}), onStatus: setStatus });
      setStatus(`Sent ${formatAmount(asset, piece)} ${asset.symbol} (tx ${r.txHash.slice(0, 10)}…). Check that it arrived where you expect; the address counts as verified.`);
      onVerified();
    } catch (e: any) { setStatus(e?.message ?? String(e)); } finally { setBusy(false); }
  }
  return (
    <div data-testid="verify-test">
      <p className="notice small">⚠ This test creates public transaction metadata: the amount, the address and the time become visible on the public side. Prefer the signed message when the destination can sign.</p>
      <p className="muted small" data-testid="verify-test-cost">
        Sends {formatAmount(asset, piece)} {asset.symbol} from your private balance to {groupAddress(entry.normalized)}
        {split ? `: ${formatAmount(asset, split.total)} ${asset.symbol} leaves it, ${formatAmount(asset, split.fee)} of that the relayer's charge and the privacy fee.` : "."}
      </p>
      <div className="tabs" style={{ margin: 0 }}><button className="primary" onClick={send} disabled={busy || !ready} data-testid="verify-test-send">Send the test transaction</button></div>
      {status && <p className="muted small">{status}</p>}
    </div>
  );
}

/** Verify an entry by one of its chain's methods. */
export function VerifyEntry({ entry, masterSeed, deployment, onDone }: { entry: AddressBookEntry; masterSeed: Uint8Array; deployment: Deployment | null; onDone?: () => void }) {
  const methods = methodsFor(entry.chain);
  const [method, setMethod] = useState<VerificationMethod>(methods[0]);
  const verified = (m: VerificationMethod) => { verifyAddress(entry.id, m); onDone?.(); };
  return (
    <div style={{ marginTop: 8 }} data-testid="verify-entry">
      <div className="segment" role="tablist" style={{ margin: "6px 0" }}>
        {methods.map((m) => <button key={m} className={method === m ? "active" : ""} onClick={() => setMethod(m)} data-method={m}>{m === "groups-read" ? "Re-type the groups" : m === "signed-message" ? "Signed message" : "Test transaction"}</button>)}
      </div>
      {method === "groups-read" && <GroupsRead entry={entry} onVerified={() => verified("groups-read")} />}
      {method === "signed-message" && <SignedMessage entry={entry} onVerified={() => verified("signed-message")} />}
      {method === "test-transaction" && <TestTransaction entry={entry} masterSeed={masterSeed} deployment={deployment} onVerified={() => verified("test-transaction")} />}
    </div>
  );
}

/** The Immediate override (§12): the typed phrase, the hold, then the second factor — the separate device at institutional, with no password fallback there. */
export function OverridePanel({ entry, tier, onDone }: { entry: AddressBookEntry; tier: Tier; onDone?: () => void }) {
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
      if (!id || !webauthnAvailable()) { setError("An immediate use at this size needs the separate device registered under Settings → Protected execution; there is no password fallback."); return; }
      if (!(await assertSecondFactor(id))) { setError("The separate device did not confirm."); return; }
      overrideCoolingOff(entry.id, "second-device"); setStep("done"); onDone?.(); return;
    }
    if (secondFactor.credentialId && webauthnAvailable() && (await assertSecondFactor(secondFactor.credentialId))) { overrideCoolingOff(entry.id, "second-factor"); setStep("done"); onDone?.(); return; }
    setStep("password");
  }
  async function withPassword() {
    setError("");
    if (!(await verifyPassword(password))) { setError("Wrong password."); return; }
    setPassword(""); overrideCoolingOff(entry.id, "second-factor"); setStep("done"); onDone?.();
  }
  if (step === "done") return <p className="muted small" data-testid="override-done">Immediate use confirmed and journaled; the cooling-off no longer applies to this address.</p>;
  return (
    <div className="notice" style={{ marginTop: 8 }} data-testid="override-panel">
      <div className="small">The cooling-off protects you from an address that was swapped under your eyes: an immediate use needs the phrase <b>{OVERRIDE_PHRASE}</b>, a hold and your {institutional ? "separate device" : "second confirmation"}.</div>
      <input value={phrase} onChange={(e: any) => setPhrase(e.target.value)} placeholder={OVERRIDE_PHRASE} autoComplete="off" data-testid="override-phrase" />
      {step === "idle" && <HoldButton label="Confirm an immediate use" holdMs={holdMs()} onConfirm={confirmed} disabled={phrase.trim() !== OVERRIDE_PHRASE} />}
      {step === "password" && (
        <div data-testid="override-password">
          <div className="small">Second confirmation: {secondFactor.credentialId ? "the authenticator did not confirm; " : "no authenticator is registered; "}enter your wallet password.</div>
          <input type="password" value={password} onChange={(e: any) => setPassword(e.target.value)} onKeyDown={(e: any) => { if (e.key === "Enter") withPassword(); }} autoComplete="current-password" />
          <button className="primary" onClick={withPassword} disabled={!password}>Confirm with the password</button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** Under a typed destination (Swap, Withdraw): the status against the book and the way forward. */
export function DestinationStatus({ chain, address, tier, masterSeed, deployment, asset }: { chain: AddressChain; address: string; tier: Tier; masterSeed: Uint8Array; deployment: Deployment | null; asset?: string }) {
  useAddressBook(); // re-render on every journal write
  const [open, setOpen] = useState<null | "verify" | "override">(null);
  const check = destinationCheck(chain, address, { tier });
  const large = atLeast(tier, "high-value");
  const entry = check.entry;
  return (
    <div className="small" style={{ margin: "-4px 0 10px" }} data-testid="destination-status" data-ok={check.ok ? "1" : "0"} data-reason={check.reason ?? ""}>
      <span className={check.ok ? "muted" : "level-Reduced"}>{check.status}</span>
      <span className="tabs" style={{ margin: "4px 0 0", display: "inline-flex" }}>
        {!entry && <button className="tab" onClick={() => { const r = addAddress({ chain, address, asset }); if (r.ok) setOpen("verify"); }} data-testid="add-to-book">Add to the address book</button>}
        {entry && (entry.verification.status !== "verified" || check.reason === "stale") && <button className="tab" onClick={() => setOpen(open === "verify" ? null : "verify")} data-testid="verify-destination">{check.reason === "stale" ? "Check it again" : "Verify"}</button>}
        {entry && check.reason === "cooling-off" && large && <button className="tab" onClick={() => setOpen(open === "override" ? null : "override")} data-testid="override-destination">Confirm an immediate use</button>}
        {entry && check.reason === "unapproved" && <button className="tab" onClick={() => approveAddress(entry.id)} data-testid="approve-destination">Approve for large payments</button>}
      </span>
      {open === "verify" && entry && (entry.verification.status !== "verified" || check.reason === "stale") && <VerifyEntry entry={entry} masterSeed={masterSeed} deployment={deployment} onDone={() => setOpen(null)} />}
      {open === "override" && entry && <OverridePanel entry={entry} tier={tier} onDone={() => setOpen(null)} />}
    </div>
  );
}

/** Settings → Address book: every entry, add, verify, label, retire. */
export function AddressBookPanel({ deployment }: { deployment: Deployment | null }) {
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
    if (!r.ok) { setError(r.reason); return; }
    setError(""); setAddress(""); setLabel(""); setVerifying(r.entry.id);
  }
  return (
    <div className="panel" data-testid="address-book">
      <h3>Address book</h3>
      <p className="muted small">Destinations of large payments are verified here, wait 24 hours after they are added unless you confirm an immediate use, and are then approved for large payments by you; an approval unused for 90 days is checked again before the next large payment. Fresh addresses of this wallet are verified by derivation and retire after one use. The book never leaves this device.</p>
      {entries.length === 0 && <p className="muted small">No entries yet.</p>}
      {entries.map((e) => {
        const check = destinationCheck(e.chain, e.normalized, { tier: "high-value", now });
        return (
          <div key={e.id} className="list-row" style={{ alignItems: "flex-start" }} data-testid="book-entry" data-lifecycle={e.lifecycle} data-source={e.source}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div><b>{e.label || "(no label)"}</b> <span className="muted small">· {chainOfEntry(e)} · {e.source === "fresh" ? "this wallet's" : "entered"} · {LIFECYCLE_WORDS[e.lifecycle]}{e.verification.method ? ` · ${METHOD_WORDS[e.verification.method]}` : ""}{e.usedBy.length ? ` · paid by ${e.usedBy.length} operation${e.usedBy.length === 1 ? "" : "s"}` : ""}</span></div>
              <code className="small" style={{ wordBreak: "break-all" }}>{groupAddress(e.address)}</code>
              <div className={check.ok ? "muted small" : "small level-Reduced"}>{check.status}</div>
              {verifying === e.id && (e.verification.status !== "verified" || check.reason === "stale") && masterSeed && <VerifyEntry entry={e} masterSeed={masterSeed} deployment={deployment} onDone={() => setVerifying(null)} />}
            </div>
            <div className="tabs" style={{ margin: 0, flexDirection: "column", alignItems: "flex-end" }}>
              {e.verification.status !== "verified" && e.lifecycle !== "retired" && <button className="tab" onClick={() => setVerifying(verifying === e.id ? null : e.id)}>Verify</button>}
              {e.source === "entered" && check.reason === "unapproved" && <button className="tab" onClick={() => approveAddress(e.id)} data-testid="approve-entry">Approve for large payments</button>}
              {e.source === "entered" && check.reason === "stale" && <button className="tab" onClick={() => setVerifying(verifying === e.id ? null : e.id)} data-testid="recheck-entry">Check it again</button>}
              {e.source === "entered" && e.lifecycle !== "retired" && <button className="tab" onClick={() => { const l = prompt("Label", e.label); if (l !== null) relabelAddress(e.id, l); }}>Label</button>}
              {e.lifecycle !== "retired" && <button className="tab" onClick={() => retireAddress(e.id)} data-testid="retire-entry">Retire</button>}
            </div>
          </div>
        );
      })}
      <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
        <label>Add an address</label>
        <select value={chain} onChange={(e: any) => setChain(e.target.value)} data-testid="book-chain">
          <option value="evm">Ethereum (any EVM network)</option>
          <option value="bitcoin">Bitcoin</option>
          <option value="solana">Solana</option>
        </select>
        <input value={address} onChange={(e: any) => setAddress(e.target.value)} placeholder="the address, as you received it" autoComplete="off" data-testid="book-address" />
        <input value={label} onChange={(e: any) => setLabel(e.target.value)} placeholder="a label (for you only)" autoComplete="off" data-testid="book-label" />
        {error && <p className="error small">{error}</p>}
        <button className="tab" onClick={add} disabled={!address.trim()} data-testid="book-add">Add</button>
      </div>
    </div>
  );
}
