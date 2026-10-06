import { useState } from "react";

// Shielding is a PUBLIC deposit (amount visible); privacy comes from later private transfers.
// A full build derives ownerCommitment from the wallet keys and sends buildShieldNative via the wallet.
export function Shield() {
  const [amount, setAmount] = useState("1.0");
  const [status, setStatus] = useState("");

  function shield() {
    setStatus(
      `Would shield ${amount} ETH into the canonical native vault (one-tap, spec §70). ` +
        `Wire the wallet send + ownerCommitment derivation in a full build.`
    );
  }

  return (
    <div className="panel">
      <h3>Shield ETH</h3>
      <label>Amount (ETH)</label>
      <input value={amount} onChange={(e: any) => setAmount(e.target.value)} />
      <button className="primary" onClick={shield}>
        Shield
      </button>
      {status && <p className="muted">{status}</p>}
    </div>
  );
}
