// A switch over Radix (spec §5): always with a visible label the control is named by.
import * as RS from "@radix-ui/react-switch";
import type { ReactNode } from "react";

export function Switch({ id, checked, onCheckedChange, label, description, disabled, testId }: { id: string; checked: boolean; onCheckedChange: (checked: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean; testId?: string }) {
  return (
    <div className="ds-switch-row">
      <label htmlFor={id} className="ds-list-main">
        <span>{label}</span>
        {description ? <span className="ds-list-sub">{description}</span> : null}
      </label>
      <RS.Root id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="ds-switch" data-testid={testId}>
        <RS.Thumb className="ds-switch-thumb" />
      </RS.Root>
    </div>
  );
}
