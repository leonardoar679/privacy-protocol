// A radio group over Radix (spec §5): the "Choose your experience" pattern — a title, then rows with a label and a
// description, one checked. Arrow keys move the selection; each row is a 44 px target.
import * as RR from "@radix-ui/react-radio-group";
import type { ReactNode } from "react";

export interface RadioOption { value: string; label: ReactNode; description?: ReactNode; testId?: string }

export function RadioGroup({ value, onValueChange, options, ariaLabel, name }: { value: string; onValueChange: (value: string) => void; options: RadioOption[]; ariaLabel: string; name?: string }) {
  return (
    <RR.Root value={value} onValueChange={onValueChange} aria-label={ariaLabel} name={name} className="ds-radio-list">
      {options.map((o) => {
        const id = `${name ?? "radio"}-${o.value}`;
        return (
          <label key={o.value} htmlFor={id} className="ds-radio-row" data-checked={value === o.value}>
            <RR.Item id={id} value={o.value} className="ds-radio" data-testid={o.testId}>
              <RR.Indicator className="ds-radio-indicator" />
            </RR.Item>
            <span className="ds-radio-text">
              <span>{o.label}</span>
              {o.description ? <span className="ds-radio-desc">{o.description}</span> : null}
            </span>
          </label>
        );
      })}
    </RR.Root>
  );
}
