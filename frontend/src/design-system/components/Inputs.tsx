// The inputs (spec §3.4–§3.6, §5): a labelled field, the amount in large tabular digits with the common-size chips
// and Max, the address with its four checks and the address book, a segmented choice, a switch row.
import { useState, type ChangeEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { cx, nextId } from "../cx";
import { AssetMonogram, Icon } from "../icons";
import { Dialog } from "../primitives/Dialog";
import { Button, IconButton } from "./Button";
import type { AssetView } from "./Money";

export function Field({ label, htmlFor, hint, error, children, testId }: { label: ReactNode; htmlFor: string; hint?: ReactNode; error?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div className="ds-field" data-testid={testId}>
      <label className="ds-field-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <span className="ds-field-error" role="alert">{error}</span> : hint ? <span className="ds-field-hint">{hint}</span> : null}
    </div>
  );
}

export function TextInput({ className, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input className={cx("ds-input", className)} aria-invalid={invalid || undefined} {...rest} />;
}

/** Accepts digits with one decimal point and at most `decimals` fractional digits; the caller keeps base units. */
export function cleanAmount(raw: string, decimals: number): string | null {
  const s = raw.replace(/,/g, "").trim();
  if (s === "") return "";
  if (!/^\d*\.?\d*$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) return null;
  return `${whole}${s.includes(".") ? `.${frac}` : ""}`;
}

export function AmountInput({ id, label, asset, value, onChange, usd, buckets, bucketsLabel = "Common sizes", onMax, maxLabel = "Max", error, hint, testId = "amount" }: { id: string; label: string; asset: { symbol: string; decimals: number }; value: string; onChange: (value: string) => void; usd?: string | null; buckets?: { label: string; value: string }[]; bucketsLabel?: string; onMax?: () => void; maxLabel?: string; error?: ReactNode; hint?: ReactNode; testId?: string }) {
  const change = (e: ChangeEvent<HTMLInputElement>) => { const v = cleanAmount(e.target.value, asset.decimals); if (v !== null) onChange(v); };
  return (
    <Field label={label} htmlFor={id} error={error} hint={hint} testId={testId}>
      <div className="ds-amount">
        <div className="ds-amount-row">
          <input id={id} className="ds-amount-input" inputMode="decimal" autoComplete="off" placeholder="0" value={value} onChange={change} aria-invalid={error ? true : undefined} data-testid={`${testId}-input`} />
          <span className="ds-amount-symbol">{asset.symbol}</span>
          {onMax ? <Button variant="secondary" onClick={onMax} data-testid={`${testId}-max`}>{maxLabel}</Button> : null}
        </div>
        {usd ? <span className="ds-amount-usd" data-testid={`${testId}-usd`}>{usd}</span> : null}
        {buckets && buckets.length ? (
          <div className="ds-chips" role="group" aria-label={bucketsLabel}>
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
export function AddressInput({ id, label, value, onChange, checks, status, onPaste, pasteLabel = "Paste", placeholder, book, onPickEntry, bookLabel = "Address book", error, testId = "address" }: { id: string; label: string; value: string; onChange: (value: string) => void; checks: AddressCheck[]; status?: ReactNode; onPaste?: () => Promise<string | null> | string | null; pasteLabel?: string; placeholder?: string; book?: BookEntryView[]; onPickEntry?: (id: string) => void; bookLabel?: string; error?: ReactNode; testId?: string }) {
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
          <input id={id} className="ds-input" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} aria-invalid={error ? true : undefined} data-testid={`${testId}-input`} />
          <IconButton label={pasteLabel} icon="paste" onClick={() => void paste()} data-testid={`${testId}-paste`} />
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
          <div className="ds-book" role="group" aria-label={bookLabel}>
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
export function AssetSelector({ open, onClose, assets, value, onChange, title = "Choose asset", searchLabel = "Search", showAddresses, testId = "asset-selector" }: { open: boolean; onClose: () => void; assets: AssetOption[]; value?: string; onChange: (id: string) => void; title?: string; searchLabel?: string; showAddresses?: boolean; testId?: string }) {
  const [q, setQ] = useState("");
  const [id] = useState(() => nextId("asset-search"));
  const shown = assets.filter((a) => `${a.symbol} ${a.name} ${a.chain ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }} title={title} variant="sheet" testId={testId}>
      <label htmlFor={id} className="sr-only">{searchLabel}</label>
      <input id={id} className="ds-input" placeholder={searchLabel} value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" data-testid={`${testId}-search`} />
      <div role="listbox" aria-label={title}>
        {shown.map((a) => (
          <button key={a.id} type="button" role="option" aria-selected={a.id === value} className="ds-asset-row" onClick={() => { onChange(a.id); onClose(); }} data-testid={`${testId}-option`}>
            <AssetMonogram symbol={a.symbol} />
            <span className="ds-asset-main"><span>{a.symbol}</span><span className="ds-asset-name">{a.chain ? `${a.name} · ${a.chain}` : a.name}{showAddresses && a.address ? ` · ${a.address}` : ""}</span></span>
            {a.balance ? <span className="ds-asset-amount"><span className="ds-numeral">{a.balance}</span></span> : null}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
