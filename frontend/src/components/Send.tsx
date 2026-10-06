import { useState } from "react";
import { buildTransact } from "../sdk/privacyProtocol";

// Private internal transfer — the preferred operation (spec §33): no public sender/recipient/amount.
export function Send() {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("0.5");
  const [status, setStatus] = useState("");

  function send() {
    try {
      buildTransact(); // stubbed: triggers the explanatory error below
    } catch (e: any) {
      setStatus(e.message);
    }
  }

  return (
    <div className="panel">
      <h3>Send privately</h3>
      <label>Recipient privacy address</label>
      <input value={recipient} onChange={(e: any) => setRecipient(e.target.value)} placeholder="pp1…" />
      <label>Amount</label>
      <input value={amount} onChange={(e: any) => setAmount(e.target.value)} />
      <button className="primary" onClick={send}>
        Generate proof &amp; send
      </button>
      {status && <p className="muted">{status}</p>}
    </div>
  );
}
