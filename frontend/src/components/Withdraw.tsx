import { useState } from "react";
import { buildTransact } from "../sdk/privacyProtocol";

// Public exit (spec §34): reveals vault/amount/recipient on settlement. Use a fresh stealth
// recipient (§35) and the privacy controls below to minimize linkage.
export function Withdraw() {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("1.0");
  const [status, setStatus] = useState("");

  function withdraw() {
    try {
      buildTransact(); // stubbed
    } catch (e: any) {
      setStatus(e.message);
    }
  }

  return (
    <div className="panel">
      <h3>Withdraw to a public address</h3>
      <label>Fresh stealth recipient (0x…)</label>
      <input value={recipient} onChange={(e: any) => setRecipient(e.target.value)} placeholder="0x…" />
      <label>Amount</label>
      <input value={amount} onChange={(e: any) => setAmount(e.target.value)} />
      <button className="primary" onClick={withdraw}>
        Generate proof &amp; withdraw
      </button>
      {status && <p className="muted">{status}</p>}
    </div>
  );
}
