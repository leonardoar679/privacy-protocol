import type { Asset } from "../sdk/assets";

/** The private asset an action works in (plan §36): ETH and every ERC-20 the deployment has a canonical vault for. */
export function AssetSelect({ assets, value, onChange, label = "Asset" }: { assets: Asset[]; value: Asset; onChange: (a: Asset) => void; label?: string }) {
  if (assets.length <= 1) return null;
  return (
    <>
      <label>{label}</label>
      <select value={value.vault} onChange={(e: any) => { const a = assets.find((x) => x.vault === e.target.value); if (a) onChange(a); }}>
        {assets.map((a) => <option key={a.vault} value={a.vault}>{a.symbol}</option>)}
      </select>
    </>
  );
}
