// Consumer view: public vs. private balances (spec §72). Illustrative values; the chain only ever
// sees commitments, nullifiers and roots.
export function PrivateBalance() {
  return (
    <div className="panel">
      <div className="row">
        <span className="muted">Public ETH</span>
        <b>0.81</b>
      </div>
      <div className="row">
        <span className="muted">Private ETH</span>
        <b>4.26</b>
      </div>
      <div className="row">
        <span className="muted">Private USDC</span>
        <b>2,400</b>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Illustrative. Merkle roots, nullifiers and the proof system are hidden from the user by design.
      </p>
    </div>
  );
}
