// The inputs (spec v2.0 §5; doc §9, §56): a labelled field, the amount in large tabular digits with the common-size
// chips and Max, the address with its four checks and the address book, a segmented choice, the asset and network
// pickers. Amounts are typed with inputmode="decimal", addresses with inputmode="text" and no autocorrection — never
// type="number".
import { useLabels } from "../labels";
import { useState, type ChangeEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { cx, nextId } from "../cx";
import { AssetMonogram, Icon } from "../icons";
import { Button, IconButton } from "./Button";
import type { AssetView } from "./Money";
import { BottomSheet } from "./Sheets";

export function Field({ label, htmlFor, hint, error, children, testId }: { label: ReactNode; htmlFor: string; hint?: ReactNode; error?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div className="ds-field" data-testid={testId}>
      <label className="ds-field-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <span className="ds-field-error" role="alert">{error}</span> : hint ? <span className="ds-field-hint">{hint}</span> : null}
    </div>
  );
}

export function Input({ className, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input className={cx("ds-input", className)} aria-invalid={invalid || undefined} {...rest} />;
}

/** A whole number grouped by threes with `sep`, its first group never 0 ("1,000,000"; never "0.000.001"). */
const groupedBy = (s: string, sep: "," | "."): boolean => (sep === "," ? /^[1-9]\d{0,2}(,\d{3})+$/ : /^[1-9]\d{0,2}(\.\d{3})+$/).test(s);

/**
 * Accepts digits with one decimal point and at most `decimals` fractional digits; the caller keeps base units. A lone comma
 * is the decimal point, as a lone dot is (a V6 follow-up of 2026-10-22, from the audit's review of the input layer): every
 * comma had been dropped as a thousands separator, so on a comma-decimal keypad — the only decimal key it offers — "0,5"
 * became "05", five, ten times what was meant. Thousands are read only where they cannot be the decimal point: two or more
 * of one separator ("1,000,000", "1.000.000"), or both kinds, the last one the decimal point ("1,000.5", "1.000,5"), each
 * grouping by threes. So an amount is never read larger than it was meant in either convention — "2,500" reads 2.5 — and
 * anything else is refused. The device's region plays no part: its keypad and its language need not agree.
 */
export function cleanAmount(raw: string, decimals: number): string | null {
  let s = raw.replace(/\s/g, "");
  if (s === "") return "";
  const commas = s.split(",").length - 1;
  const dots = s.split(".").length - 1;
  if (commas && dots) {
    const at = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
    const group = s[at] === "," ? "." : ",";
    const whole = s.slice(0, at);
    const frac = s.slice(at + 1);
    // a point typed after the field's own ("1.000," then "5") is refused, never a thousand
    if (!/^\d+$/.test(frac) || !groupedBy(whole, group)) return null;
    s = `${whole.split(group).join("")}.${frac}`;
  } else if (commas + dots > 1) {
    const group = commas ? "," : ".";
    if (!groupedBy(s, group)) return null;
    s = s.split(group).join("");
  } else s = s.replace(",", ".");
  if (!/^\d*\.?\d*$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) return null;
  return `${whole}${s.includes(".") ? `.${frac}` : ""}`;
}

export function AmountInput({ id, label, asset, value, onChange, usd, buckets, bucketsLabel, onMax, maxLabel, error, hint, testId = "amount" }: { id: string; label: string; asset: { symbol: string; decimals: number }; value: string; onChange: (value: string) => void; usd?: string | null; buckets?: { label: string; value: string }[]; bucketsLabel?: string; onMax?: () => void; maxLabel?: string; error?: ReactNode; hint?: ReactNode; testId?: string }) {
  const L = useLabels();
  const change = (e: ChangeEvent<HTMLInputElement>) => { const v = cleanAmount(e.target.value, asset.decimals); if (v !== null) onChange(v); };
  return (
    <Field label={label} htmlFor={id} error={error} hint={hint} testId={testId}>
      <div className="ds-amount">
        <div className="ds-amount-row">
          <input id={id} className="ds-amount-input" inputMode="decimal" autoComplete="off" placeholder="0" value={value} onChange={change} aria-invalid={error ? true : undefined} data-testid={`${testId}-input`} />
          <span className="ds-amount-symbol">{asset.symbol}</span>
          {onMax ? <Button variant="secondary" onClick={onMax} data-testid={`${testId}-max`}>{maxLabel ?? L.max}</Button> : null}
        </div>
        {usd ? <span className="ds-amount-usd" data-testid={`${testId}-usd`}>{usd}</span> : null}
        {buckets && buckets.length ? (
          <div className="ds-chips" role="group" aria-label={bucketsLabel ?? L.commonSizes}>
            {buckets.map((b) => <button key={b.value} type="button" className="ds-chip" aria-pressed={value === b.value} onClick={() => onChange(b.value)} data-testid={`${testId}-bucket`}>{b.label}</button>)}
          </div>
        ) : null}
      </div>
    </Field>
  );
}

export type CheckState = "ok" | "fail" | "pending" | "idle";
export interface AddressCheck { label: string; state: CheckState; detail?: string }
export interface BookEntryView { id: string; label: string; address: string }

/** Plan §16: the four checks under the address, a paste control, the address book's entries. */
export function AddressInput({ id, label, value, onChange, checks, status, onPaste, pasteLabel, placeholder, book, onPickEntry, bookLabel, error, testId = "address" }: { id: string; label: string; value: string; onChange: (value: string) => void; checks: AddressCheck[]; status?: ReactNode; onPaste?: () => Promise<string | null> | string | null; pasteLabel?: string; placeholder?: string; book?: BookEntryView[]; onPickEntry?: (id: string) => void; bookLabel?: string; error?: ReactNode; testId?: string }) {
  const L = useLabels();
  const paste = async () => {
    try {
      const text = onPaste ? await onPaste() : typeof navigator !== "undefined" && navigator.clipboard?.readText ? await navigator.clipboard.readText() : null;
      if (text) onChange(text.trim());
    } catch { /* the clipboard was refused: the field stays as it was */ }
  };
  return (
    <Field label={label} htmlFor={id} error={error} testId={testId}>
      <div className="ds-address">
        <div className="ds-address-row">
          <input id={id} className="ds-input" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} inputMode="text" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-invalid={error ? true : undefined} data-testid={`${testId}-input`} />
          <IconButton label={pasteLabel ?? L.paste} icon="paste" onClick={() => void paste()} data-testid={`${testId}-paste`} />
        </div>
        {checks.length ? (
          <ul className="ds-checks" data-testid={`${testId}-checks`}>
            {checks.map((c) => (
              <li key={c.label} data-state={c.state}>
                <Icon name={c.state === "ok" ? "check" : c.state === "fail" ? "close" : c.state === "pending" ? "clock" : "minus"} size={14} />{" "}
                {c.label}{c.detail ? ` — ${c.detail}` : ""}
              </li>
            ))}
          </ul>
        ) : null}
        {status}
        {book && book.length && onPickEntry ? (
          <div className="ds-book" role="group" aria-label={bookLabel ?? L.addressBook}>
            {book.map((b) => <button key={b.id} type="button" className="ds-chip" onClick={() => onPickEntry(b.id)} data-testid={`${testId}-book-entry`}>{b.label}</button>)}
          </div>
        ) : null}
      </div>
    </Field>
  );
}

export interface SegmentedOption { value: string; label: string; testId?: string }
export function Segmented({ value, onChange, options, ariaLabel, name }: { value: string; onChange: (value: string) => void; options: SegmentedOption[]; ariaLabel: string; name?: string }) {
  return (
    <div className="ds-segmented" role="radiogroup" aria-label={ariaLabel} data-testid={name}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} data-state={value === o.value ? "checked" : "unchecked"} className="ds-segmented-item" onClick={() => onChange(o.value)} data-testid={o.testId}>{o.label}</button>
      ))}
    </div>
  );
}

export interface AssetOption extends AssetView { id: string; balance?: string; chain?: string }

/** Plan §53: a sheet with a search field and rows of monogram, symbol, name and protected balance; addresses only under Advanced. */
export function AssetSelector({ open, onClose, assets, value, onChange, title, searchLabel, showAddresses, testId = "asset-selector" }: { open: boolean; onClose: () => void; assets: AssetOption[]; value?: string; onChange: (id: string) => void; title?: string; searchLabel?: string; showAddresses?: boolean; testId?: string }) {
  const L = useLabels();
  const heading = title ?? L.chooseAsset;
  const search = searchLabel ?? L.search;
  const [q, setQ] = useState("");
  const [id] = useState(() => nextId("asset-search"));
  const shown = assets.filter((a) => `${a.symbol} ${a.name} ${a.chain ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <BottomSheet open={open} onClose={onClose} title={heading} testId={testId} id={testId}>
      <label htmlFor={id} className="sr-only">{search}</label>
      <input id={id} className="ds-input" placeholder={search} value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" data-testid={`${testId}-search`} />
      <div role="listbox" aria-label={heading}>
        {shown.map((a) => (
          <button key={a.id} type="button" role="option" aria-selected={a.id === value} className="ds-asset-row" onClick={() => { onChange(a.id); onClose(); }} data-testid={`${testId}-option`}>
            <AssetMonogram symbol={a.symbol} />
            <span className="ds-asset-main"><span>{a.symbol}</span><span className="ds-asset-name">{a.chain ? `${a.name} · ${a.chain}` : a.name}{showAddresses && a.address ? ` · ${a.address}` : ""}</span></span>
            {a.balance ? <span className="ds-asset-amount"><span className="ds-numeral">{a.balance}</span></span> : null}
          </button>
        ))}
      </div>
    </BottomSheet>
  );
}

export interface ChainOption {
  id: string;
  name: string;
  /** a short fact under the name ("Fees ≈ $0.40", "Recommended") */
  detail?: string;
  /** false: listed and explained, not selectable (spec §9: temporarily unavailable) */
  available?: boolean;
  unavailableReason?: string;
}

/** The network picker (doc §9, §55): a sheet on a phone, a centred dialog from 1024 px; an unavailable network says why. */
export function ChainSelector({
  open,
  onClose,
  chains,
  value,
  onChange,
  title,
  testId = "chain-selector",
}: {
  open: boolean;
  onClose: () => void;
  chains: ChainOption[];
  value?: string;
  onChange: (id: string) => void;
  title?: string;
  testId?: string;
}) {
  const L = useLabels();
  const heading = title ?? L.chooseNetwork;
  return (
    <BottomSheet open={open} onClose={onClose} title={heading} testId={testId} id={testId}>
      <div role="listbox" aria-label={heading}>
        {chains.map((c) => {
          const off = c.available === false;
          return (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={c.id === value}
              aria-disabled={off || undefined}
              className="ds-asset-row ds-chain-row"
              onClick={() => {
                if (off) return;
                onChange(c.id);
                onClose();
              }}
              data-testid={`${testId}-option`}
              data-chain={c.id}
              data-available={off ? "false" : "true"}
            >
              <span className="ds-chain-mark" aria-hidden>
                <Icon name="globe" size={20} />
              </span>
              <span className="ds-asset-main">
                <span>{c.name}</span>
                {off || c.detail ? <span className="ds-asset-name">{off ? (c.unavailableReason ?? L.unavailable) : c.detail}</span> : null}
              </span>
              {c.id === value ? <Icon name="check" size={18} /> : null}
            </button>
          );
        })}
      </div>
    </BottomSheet>
  );
}
