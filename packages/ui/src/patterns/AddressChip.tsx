// An address as a chip (spec v2.0 §5): `0x43…82C1`, `bc1q…82c1`; the whole address is its accessible name and tooltip,
// and an optional copy control copies all of it. A full 0x-40 address never stands in a Simple screen (doc §92).
import { useState } from "react";
import { useLabels } from "../labels";
import { shortAddress } from "../format";
import { Icon } from "../icons";

export function AddressChip({ address, label, copyable, testId = "address-chip" }: { address: string; label?: string; copyable?: boolean; testId?: string }) {
  const L = useLabels();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the clipboard was refused: nothing to show */
    }
  };
  return (
    <span className="ds-address-chip" data-testid={testId}>
      <span className="ds-address-chip-text" title={address} aria-label={label ? `${label}: ${address}` : address}>
        {shortAddress(address)}
      </span>
      {copyable ? (
        <button
          type="button"
          className="ds-address-chip-copy"
          onClick={() => void copy()}
          aria-label={copied ? L.copied : L.copy}
          title={copied ? L.copied : L.copy}
          data-testid={`${testId}-copy`}
        >
          <Icon name={copied ? "check" : "copy"} size={16} />
        </button>
      ) : null}
    </span>
  );
}
