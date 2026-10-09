// The shell, the page, the bars and the card (spec §2, §5): a phone's bottom navigation that becomes a top bar from
// 1024 px, a page with its back control and one sticky primary action, cards with soft elevation.
import type { ReactNode } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons";
import { IconButton } from "./Button";

export function Card({ elevation = 1, padding = "md", className, children, testId, as: Tag = "div" }: { elevation?: 0 | 1 | 2; padding?: "none" | "md" | "lg"; className?: string; children: ReactNode; testId?: string; as?: "div" | "section" | "article" }) {
  return <Tag className={cx("ds-card", `ds-elev-${elevation}`, `ds-pad-${padding}`, className)} data-testid={testId}>{children}</Tag>;
}

export function TopBar({ title, back, backLabel = "Back", actions, status, testId }: { title: ReactNode; back?: () => void; backLabel?: string; actions?: ReactNode; status?: ReactNode; testId?: string }) {
  return (
    <header className="ds-topbar" data-testid={testId}>
      {back ? <IconButton label={backLabel} icon="chevron-left" onClick={back} data-testid="back" /> : null}
      <h1 className="ds-topbar-title">{title}</h1>
      {actions || status ? <div className="ds-topbar-actions">{status}{actions}</div> : null}
    </header>
  );
}

export function Page({ title, back, backLabel, actions, status, primaryAction, width = "phone", children, testId }: { title: ReactNode; back?: () => void; backLabel?: string; actions?: ReactNode; status?: ReactNode; primaryAction?: ReactNode; width?: "phone" | "wide"; children: ReactNode; testId?: string }) {
  return (
    <div className={cx("ds-page", width === "wide" && "ds-page-wide")} data-testid={testId}>
      <TopBar title={title} back={back} backLabel={backLabel} actions={actions} status={status} />
      <div className="ds-page-body">{children}</div>
      {primaryAction ? <div className="ds-page-footer">{primaryAction}</div> : null}
    </div>
  );
}

export interface NavItem { to: string; label: string; icon: IconName; testId?: string }

/** Four items, never more (spec §2): anchors so the destinations are real links; `onSelect` navigates in the app. */
export function BottomNav({ items, current, onSelect, label = "Main", brand }: { items: NavItem[]; current: string; onSelect: (to: string) => void; label?: string; brand?: ReactNode }) {
  return (
    <nav className="ds-bottomnav" aria-label={label}>
      {brand ? <div className="ds-brand">{brand}</div> : null}
      {items.map((i) => {
        const active = current === i.to || (i.to !== "/" && current.startsWith(`${i.to}/`));
        return (
          <a key={i.to} href={i.to} className={cx("ds-nav-item", active && "ds-nav-item-active")} aria-current={active ? "page" : undefined} data-testid={i.testId}
            onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); onSelect(i.to); }}>
            <Icon name={i.icon} size={22} />
            <span>{i.label}</span>
          </a>
        );
      })}
    </nav>
  );
}

export function AppShell({ nav, children }: { nav?: ReactNode; children: ReactNode }) {
  return (
    <div className="ds-shell">
      <main className="ds-main">{children}</main>
      {nav}
    </div>
  );
}
