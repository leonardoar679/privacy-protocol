import { useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import type { ChainAccount, ChainKind } from "@ref/wallet/chainKeys";
import { privacyAddress } from "../sdk/privateTx";
import { consumeFreshAddress, lastFreshAddress } from "../keys/chainKeys";

// Receive (plan §46): the wallet's private address for pool payments, and FRESH per-asset addresses
// (Bitcoin / Solana / EVM) from the Chain Key Abstraction — a new one on demand, each meant to be
// used once, so the permanent public address never has to be shown to anyone. QR + address only.
type Asset = "private-eth" | "bitcoin" | "solana" | "evm";
const ASSETS: { id: Asset; label: string; chain?: ChainKind; note: string }[] = [
  { id: "private-eth", label: "ETH · private", note: "Senders pay you inside the pool with this address; nothing about the payment is public." },
  { id: "bitcoin", label: "Bitcoin", chain: "bitcoin", note: "A fresh address of this wallet (bc1q…). Use each address once; the next one is a click away." },
  { id: "solana", label: "Solana", chain: "solana", note: "A fresh account of this wallet. Use each address once." },
  { id: "evm", label: "ETH · public (fresh)", chain: "evm", note: "A fresh public account of this wallet, valid on every EVM network. Shield what arrives to make it private." },
];

function QR({ text }: { text: string }) {
  const svg = useMemo(() => { const q = qrcode(0, "M"); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }, [text]);
  return <div style={{ width: 180, height: 180, background: "#fff", padding: 6, borderRadius: 8 }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function Receive({ masterSeed }: { masterSeed: Uint8Array }) {
  const [asset, setAsset] = useState<Asset>("private-eth");
  const [shown, setShown] = useState<Partial<Record<ChainKind, ChainAccount>>>({});
  const a = ASSETS.find((x) => x.id === asset)!;
  const current = a.chain ? shown[a.chain] ?? lastFreshAddress(masterSeed, a.chain) : null;
  const address = a.chain ? current?.address ?? "" : privacyAddress(masterSeed);

  function generate() {
    if (!a.chain) return;
    const acct = consumeFreshAddress(masterSeed, a.chain);
    setShown((s) => ({ ...s, [a.chain!]: acct }));
  }

  return (
    <div className="panel">
      <h3>Receive</h3>
      <label>Asset</label>
      <select value={asset} onChange={(e: any) => setAsset(e.target.value)}>
        {ASSETS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
      </select>
      <p className="muted" style={{ fontSize: 13 }}>{a.note}</p>
      {address ? (
        <div className="row" style={{ alignItems: "flex-start" }}>
          <QR text={address} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <code style={{ fontSize: 12, wordBreak: "break-all", display: "block" }}>{address}</code>
            {current && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>fresh address #{current.index + 1}</div>}
            <div className="tabs">
              <button className="tab" onClick={() => navigator.clipboard?.writeText(address)}>Copy</button>
              {a.chain && <button className="tab" onClick={generate}>New address</button>}
            </div>
          </div>
        </div>
      ) : (
        <button className="primary" onClick={generate}>Generate a private receiving address</button>
      )}
    </div>
  );
}
