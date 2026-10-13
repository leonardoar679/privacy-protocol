// Tabs over Radix (spec §5): a labelled list of triggers and one panel per value; arrow keys move between tabs.
import * as RT from "@radix-ui/react-tabs";
import type { ReactNode } from "react";

export interface TabItem { value: string; label: string; content: ReactNode; testId?: string }

export function Tabs({ value, onValueChange, items, ariaLabel }: { value: string; onValueChange: (value: string) => void; items: TabItem[]; ariaLabel: string }) {
  return (
    <RT.Root value={value} onValueChange={onValueChange} className="ds-tabs">
      <RT.List className="ds-tabs-list" aria-label={ariaLabel}>
        {items.map((i) => <RT.Trigger key={i.value} value={i.value} className="ds-tab" data-testid={i.testId}>{i.label}</RT.Trigger>)}
      </RT.List>
      {items.map((i) => <RT.Content key={i.value} value={i.value} className="ds-tabs-panel">{i.content}</RT.Content>)}
    </RT.Root>
  );
}
