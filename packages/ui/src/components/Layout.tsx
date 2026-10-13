// The shell, the page, the bars and the card (spec v2.0 §5–§6; doc §11–§12, §53–§54, §88). On a phone: the content and
// BottomNavigation `Home · Swap · Activity · More` — four items, never more. From 1024 px: one top bar `Logo · Home Swap
// Activity · Wallet` above the content (the Wallet menu holds the connection and every More entry) and no bottom bar.
// The DOM order is the visual order: the top bar, then <main>, then the phone's bottom bar (V5 drew the desktop bar
// after the content). Exactly one bar exists at a time — chosen at the breakpoint — so assistive technology and every
// test environment see one navigation, not one shown and one hidden by a stylesheet.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useLabels } from "../labels";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons";
import { StickyAction } from "../patterns/StickyAction";
import { BREAKPOINTS } from "../tokens/index";
import { useMediaQuery } from "../useMediaQuery";
import { IconButton } from "./Button";

/** The width from which the top bar replaces the bottom bar (spec §6: 1024 px). */
export const DESKTOP_QUERY = `(min-width: ${BREAKPOINTS.xl}px)`;

export function Card({
  elevation = 1,
  padding = "md",
  className,
  children,
  testId,
  as: Tag = "div",
}: {
  elevation?: 0 | 1 | 2;
  padding?: "none" | "sm" | "md" | "lg";
  className?: string;
  children: ReactNode;
  testId?: string;
  as?: "div" | "section" | "article";
}) {
  return (
    <Tag className={cx("ds-card", `ds-elev-${elevation}`, `ds-pad-${padding}`, className)} data-testid={testId}>
      {children}
    </Tag>
  );
}

/** A screen's header: the back control, the title, the actions (doc §11). */
export function Header({
  title,
  back,
  backLabel,
  actions,
  status,
  testId,
}: {
  title: ReactNode;
  back?: () => void;
  backLabel?: string;
  actions?: ReactNode;
  status?: ReactNode;
  testId?: string;
}) {
  const L = useLabels();
  return (
    <header className="ds-header" data-testid={testId}>
      {back ? <IconButton label={backLabel ?? L.back} icon="chevron-left" onClick={back} data-testid="back" /> : null}
      <h1 className="ds-header-title">{title}</h1>
      {actions || status ? (
        <div className="ds-header-actions">
          {status}
          {actions}
        </div>
      ) : null}
    </header>
  );
}

/** A screen: its header, its content and its one primary action, which stays reachable above the keyboard (doc §56). */
export function Page({
  title,
  back,
  backLabel,
  actions,
  status,
  primaryAction,
  width = "phone",
  children,
  testId,
}: {
  title: ReactNode;
  back?: () => void;
  backLabel?: string;
  actions?: ReactNode;
  status?: ReactNode;
  primaryAction?: ReactNode;
  width?: "phone" | "wide";
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className={cx("ds-page", width === "wide" && "ds-page-wide")} data-testid={testId}>
      <Header title={title} back={back} backLabel={backLabel} actions={actions} status={status} />
      <div className="ds-page-body">{children}</div>
      {primaryAction ? <StickyAction>{primaryAction}</StickyAction> : null}
    </div>
  );
}

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  testId?: string;
}

const isActive = (current: string, to: string) => current === to || (to !== "/" && current.startsWith(`${to}/`));

function NavLink({
  item,
  current,
  onSelect,
  className,
  activeClassName,
  iconSize,
}: {
  item: NavItem;
  current: string;
  onSelect: (to: string) => void;
  className: string;
  activeClassName: string;
  iconSize: number;
}) {
  const active = isActive(current, item.to);
  return (
    <a
      href={item.to}
      className={cx(className, active && activeClassName)}
      aria-current={active ? "page" : undefined}
      data-testid={item.testId}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onSelect(item.to);
      }}
    >
      <Icon name={item.icon} size={iconSize} />
      <span>{item.label}</span>
    </a>
  );
}

/** The phone's bottom bar: four items, never more (spec §6); anchors, so every destination is a real link. */
export function BottomNavigation({ items, current, onSelect, label }: { items: NavItem[]; current: string; onSelect: (to: string) => void; label?: string }) {
  const L = useLabels();
  return (
    <nav className="ds-bottomnav" aria-label={label ?? L.mainNav} data-testid="bottom-navigation">
      {items.slice(0, 4).map((i) => (
        <NavLink key={i.to} item={i} current={current} onSelect={onSelect} className="ds-nav-item" activeClassName="ds-nav-item-active" iconSize={22} />
      ))}
    </nav>
  );
}

/**
 * A disclosure menu (the desktop Wallet menu, spec §6): a button that opens a panel of links under it. Escape and a
 * click outside close it and focus returns to the button; the content receives `close` for its own links.
 */
export function Menu({
  label,
  icon,
  badge,
  children,
  testId = "menu",
  align = "end",
}: {
  label: string;
  icon?: IconName;
  badge?: ReactNode;
  children: (close: () => void) => ReactNode;
  testId?: string;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  return (
    <div className="ds-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className={cx("ds-menu-button", open && "ds-menu-button-open")}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        data-testid={testId}
      >
        {icon ? <Icon name={icon} size={20} /> : null}
        <span>{label}</span>
        {badge}
        <Icon name="chevron-down" size={16} />
      </button>
      {open ? (
        <div id={id} className={cx("ds-menu-panel", align === "start" && "ds-menu-panel-start")} data-testid={`${testId}-panel`}>
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}

/** The navigation the shell draws: the phone's four items, the desktop's three and its menu. */
export interface ShellNav {
  brand: ReactNode;
  items: NavItem[];
  desktopItems: NavItem[];
  current: string;
  onSelect: (to: string) => void;
  menu?: { label: string; icon?: IconName; badge?: ReactNode; content: (close: () => void) => ReactNode; testId?: string };
  label?: string;
}

/** The desktop top bar (from 1024 px): the logo, Home · Swap · Activity, the Wallet menu. */
function AppBar({ nav }: { nav: ShellNav }) {
  const L = useLabels();
  return (
    <header className="ds-appbar" data-testid="app-bar">
      <div className="ds-appbar-inner">
        <div className="ds-brand">{nav.brand}</div>
        <nav className="ds-topnav" aria-label={nav.label ?? L.mainNav} data-testid="top-navigation">
          {nav.desktopItems.map((i) => (
            <NavLink
              key={i.to}
              item={{ ...i, testId: i.testId ? `top-${i.testId}` : undefined }}
              current={nav.current}
              onSelect={nav.onSelect}
              className="ds-topnav-item"
              activeClassName="ds-topnav-item-active"
              iconSize={18}
            />
          ))}
        </nav>
        {nav.menu ? (
          <Menu label={nav.menu.label} icon={nav.menu.icon} badge={nav.menu.badge} testId={nav.menu.testId ?? "wallet-menu"}>
            {nav.menu.content}
          </Menu>
        ) : null}
      </div>
    </header>
  );
}

export function AppShell({ nav, children }: { nav?: ShellNav; children: ReactNode }) {
  const L = useLabels();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  return (
    <div className="ds-shell" data-layout={desktop ? "desktop" : "phone"}>
      <a className="ds-skip" href="#main">
        {L.skipToContent}
      </a>
      {nav && desktop ? <AppBar nav={nav} /> : null}
      <main className="ds-main" id="main" tabIndex={-1}>
        {children}
      </main>
      {nav && !desktop ? <BottomNavigation items={nav.items} current={nav.current} onSelect={nav.onSelect} label={nav.label} /> : null}
    </div>
  );
}
