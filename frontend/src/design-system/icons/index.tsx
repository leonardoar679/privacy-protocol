// The icon set (spec §4): inline SVG on a 24 grid, stroked with `currentColor`, hidden from assistive technology
// unless given a title. No logos: an asset is a monogram (AssetMonogram), never a brand image.
import { cx } from "../cx";

export type IconName =
  | "shield" | "shield-check" | "shield-plus" | "home" | "swap" | "activity" | "more" | "send" | "receive" | "wallet" | "gear"
  | "chevron-right" | "chevron-down" | "chevron-left" | "check" | "check-circle" | "warning" | "info" | "close" | "copy" | "qr"
  | "search" | "clock" | "refresh" | "external-link" | "eye" | "eye-off" | "lock" | "unlock" | "key" | "globe" | "recovery"
  | "paste" | "spinner" | "plus" | "minus" | "trash" | "download" | "upload" | "bell" | "arrow-down" | "arrow-right";

const SHIELD = "M12 3 5 6v5c0 4.5 3 8.3 7 9.6 4-1.3 7-5.1 7-9.6V6z";
const PATHS: Record<IconName, string> = {
  shield: SHIELD,
  "shield-check": `${SHIELD}m-3 9 2 2 4-4`,
  "shield-plus": `${SHIELD}M12 9v6M9 12h6`,
  home: "M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  swap: "M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  more: "M4 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0M11 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0M18 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
  receive: "M12 3v14M12 17l-5-5M12 17l5-5M4 21h16",
  wallet: "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM16 12h5M16 10v4",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  "chevron-right": "m9 6 6 6-6 6",
  "chevron-down": "m6 9 6 6 6-6",
  "chevron-left": "m15 6-6 6 6 6",
  check: "m5 12 5 5L20 7",
  "check-circle": "M22 12A10 10 0 1 1 12 2a10 10 0 0 1 10 10zm-13 0 2 2 4-4",
  warning: "M12 3 2 20h20zM12 9v5M12 17h.01",
  info: "M12 22A10 10 0 1 0 12 2a10 10 0 0 0 0 20zM12 11v5M12 8h.01",
  close: "M18 6 6 18M6 6l12 12",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  clock: "M12 22A10 10 0 1 0 12 2a10 10 0 0 0 0 20zM12 6v6l4 2",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6",
  "external-link": "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  "eye-off": "M17.9 17.9A10 10 0 0 1 12 20C5 20 1 12 1 12a18 18 0 0 1 5.1-5.9M9.9 4.2A9 9 0 0 1 12 4c7 0 11 8 11 8a18 18 0 0 1-2.2 3.2M1 1l22 22",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  unlock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 7.5-2",
  key: "m21 2-2 2m-7.6 7.6a5 5 0 1 1-7.1-7.1 5 5 0 0 1 7.1 7.1zm0 0L19 4m-3 3 2 2",
  globe: "M12 22A10 10 0 1 0 12 2a10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20",
  recovery: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2",
  paste: "M9 4h6v3H9zM6 6H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1",
  spinner: "M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14",
  download: "M12 3v12M12 15l-4-4M12 15l4-4M4 21h16",
  upload: "M12 21V9M12 9l-4 4M12 9l4 4M4 3h16",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  "arrow-down": "M12 5v14M12 19l-6-6M12 19l6-6",
  "arrow-right": "M5 12h14M19 12l-6-6M19 12l-6 6",
};
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export function Icon({ name, size = 24, title, className }: { name: IconName; size?: number; title?: string; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden={title ? undefined : true} role={title ? "img" : undefined} className={cx("ds-icon", className)} focusable="false">
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}

/** An asset's monogram (the first letters of its symbol) in place of a logo. */
export function AssetMonogram({ symbol, size = 36 }: { symbol: string; size?: number }) {
  const text = symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, symbol.length > 3 ? 2 : 3).toUpperCase() || "?";
  return <span className="ds-monogram" aria-hidden style={{ width: size, height: size, flexBasis: size }}>{text}</span>;
}
