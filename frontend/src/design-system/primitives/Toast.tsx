// Toasts over Radix (spec §5): a provider at the app's root, `useToast()` anywhere below it. A toast announces a state
// change (quote updated, proof generated, transaction submitted, protection completed) and nothing else.
import * as RT from "@radix-ui/react-toast";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { cx } from "../cx";

export type ToastKind = "info" | "success" | "warn" | "danger";
export interface ToastInput { kind?: ToastKind; title: string; body?: string; durationMs?: number }
interface ToastItem extends ToastInput { id: string }

const Ctx = createContext<(t: ToastInput) => void>(() => {});
let seq = 0;

export function ToastProvider({ children, viewportLabel = "Notifications" }: { children: ReactNode; viewportLabel?: string }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: ToastInput) => setItems((xs) => [...xs, { id: `toast-${++seq}`, ...t }]), []);
  const remove = useCallback((id: string) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const value = useMemo(() => push, [push]);
  return (
    <Ctx.Provider value={value}>
      <RT.Provider swipeDirection="down">
        {children}
        {items.map((i) => (
          <RT.Root key={i.id} className={cx("ds-toast", `ds-toast-${i.kind ?? "info"}`)} duration={i.durationMs ?? 5000} onOpenChange={(open) => { if (!open) remove(i.id); }} data-testid="toast">
            <RT.Title className="ds-toast-title">{i.title}</RT.Title>
            {i.body ? <RT.Description className="ds-toast-body">{i.body}</RT.Description> : null}
          </RT.Root>
        ))}
        <RT.Viewport className="ds-toast-viewport" label={viewportLabel} />
      </RT.Provider>
    </Ctx.Provider>
  );
}

export const useToast = (): ((t: ToastInput) => void) => useContext(Ctx);
