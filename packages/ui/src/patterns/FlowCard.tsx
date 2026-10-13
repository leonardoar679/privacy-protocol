// The one model of every money flow (spec v2.0 §1, §5; doc §3): what you have → what you want. Protect, Send, Swap and
// Cross-chain all draw it — the source side (an asset, an amount or its input) above, the destination side below, an
// arrow between them (a switch control when the direction can turn).
import type { ReactNode } from "react";
import { useLabels } from "../labels";
import { AssetMonogram, Icon } from "../icons";
import { IconButton } from "../components/Button";

export interface FlowSide {
  /** "You protect", "You send", "You pay" / "You receive", "Recipient receives" */
  label: string;
  asset: { symbol: string; name?: string };
  /** where the funds are or go: "Ethereum", "Protected balance", "Bitcoin" */
  network?: string;
  /** opens the asset (or network) selector */
  onAsset?: () => void;
  assetLabel?: string;
  /** the amount (an AmountText) or its input (an amount field without its own label) */
  children?: ReactNode;
  /** a line under the amount: the USD value, "Balance 12,400 USDC" */
  sub?: ReactNode;
  testId?: string;
}

function Side({ side }: { side: FlowSide }) {
  const assetBody = (
    <>
      <AssetMonogram symbol={side.asset.symbol} size={32} />
      <span className="ds-flow-asset-text">
        <span className="ds-flow-asset-symbol">{side.asset.symbol}</span>
        {side.network ? <span className="ds-flow-network">{side.network}</span> : null}
      </span>
      {side.onAsset ? <Icon name="chevron-down" size={16} /> : null}
    </>
  );
  return (
    <div className="ds-flow-side" data-testid={side.testId}>
      <span className="ds-flow-label">{side.label}</span>
      <div className="ds-flow-row">
        <div className="ds-flow-amount">{side.children}</div>
        {side.onAsset ? (
          <button
            type="button"
            className="ds-flow-asset"
            onClick={side.onAsset}
            aria-label={side.assetLabel ?? side.asset.symbol}
            data-testid={side.testId ? `${side.testId}-asset` : undefined}
          >
            {assetBody}
          </button>
        ) : (
          <span className="ds-flow-asset ds-flow-asset-static">{assetBody}</span>
        )}
      </div>
      {side.sub ? <span className="ds-flow-sub">{side.sub}</span> : null}
    </div>
  );
}

export function FlowCard({
  from,
  to,
  onSwitch,
  switchLabel,
  testId = "flow",
}: {
  from: FlowSide;
  to: FlowSide;
  onSwitch?: () => void;
  switchLabel?: string;
  testId?: string;
}) {
  const L = useLabels();
  return (
    <section className="ds-flow" data-testid={testId}>
      <Side side={from} />
      <div className="ds-flow-divider">
        {onSwitch ? (
          <IconButton label={switchLabel ?? L.switchDirection} icon="swap" onClick={onSwitch} className="ds-flow-switch" data-testid={`${testId}-switch`} />
        ) : (
          <span className="ds-flow-arrow" aria-hidden>
            <Icon name="arrow-down" size={18} />
          </span>
        )}
      </div>
      <Side side={to} />
    </section>
  );
}
