import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { publicBalanceViaInjectedWallet, type Deployment } from "../sdk/chain";
import { privacyAddress, scanNotes } from "../sdk/privateTx";
import { useNotes } from "../wallet/notes";
import { useSettings } from "../wallet/settings";

// Consumer view (spec §72, plan §36): the two balances side by side — the shielded balance is the sum
// of our unspent notes (created here or discovered on chain, spec §12); the public one is the
// connected account's, read through that wallet's own provider so our RPC endpoints never see the address.
export function PrivateBalance({ deployment, masterSeed, account }: { deployment: Deployment | null; masterSeed: Uint8Array; account: string | null }) {
  const notes = useNotes();
  const { advanced } = useSettings();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [publicWei, setPublicWei] = useState<bigint | null>(null);
  const vault = deployment ? BigInt(deployment.ethVault) : null;
  const mine = notes.filter((n) => vault === null || n.note.vaultId === vault);
  const unspent = mine.filter((n) => !n.spent);
  const total = unspent.reduce((s, n) => s + n.note.amount, 0n);
  const address = privacyAddress(masterSeed);

  useEffect(() => {
    if (!account) { setPublicWei(null); return; }
    publicBalanceViaInjectedWallet(account).then(setPublicWei).catch(() => setPublicWei(null));
  }, [account]);

  async function rescan() {
    if (!deployment) { setStatus("No deployment configured (VITE_RPC_URLS / VITE_CORE / VITE_ETH_VAULT)."); return; }
    setBusy(true);
    try {
      const r = await scanNotes({ masterSeed, deployment, onStatus: setStatus });
      setStatus(`Scanned ${r.scanned} payloads: ${r.found} ours, ${r.added} new, ${r.spent} spent.`);
    } catch (e: any) {
      setStatus(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="row">
        <span className="muted">Private ETH</span>
        <b>{formatEther(total)}</b>
      </div>
      <div className="row">
        <span className="muted">Public ETH {account ? `(${account.slice(0, 6)}…${account.slice(-4)})` : ""}</span>
        <b>{account ? (publicWei === null ? "…" : formatEther(publicWei)) : "connect a wallet to see it"}</b>
      </div>
      <div className="row">
        <span className="muted">Your privacy address (give this to senders)</span>
        <button className="tab" onClick={() => navigator.clipboard?.writeText(address)}>Copy</button>
      </div>
      <code style={{ fontSize: 11, wordBreak: "break-all" }}>{address}</code>
      {mine.length > 0 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {advanced
            ? mine.map((n) => (
                <div key={`${n.leafIndex}-${n.txHash ?? ""}`} className="row">
                  <span>leaf {n.leafIndex} · {n.label ?? "note"}{n.spent ? " · spent" : ""}</span>
                  <span>{formatEther(n.note.amount)} ETH</span>
                </div>
              ))
            : <div>{unspent.length} spendable note{unspent.length === 1 ? "" : "s"}{mine.length > unspent.length ? ` · ${mine.length - unspent.length} spent` : ""}</div>}
        </div>
      )}
      <div className="tabs" style={{ marginTop: 8 }}>
        <button className="tab" onClick={rescan} disabled={busy}>Rescan the chain for my notes</button>
      </div>
      {status && <p className="muted" style={{ fontSize: 12 }}>{status}</p>}
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Notes are recovered from chain with the view key (payloads are encrypted to it) and kept in your encrypted journal.{advanced ? " Merkle roots, nullifiers and the proof system stay hidden by design." : ""}
      </p>
    </div>
  );
}
