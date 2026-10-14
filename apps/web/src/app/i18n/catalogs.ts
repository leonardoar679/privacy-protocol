// The catalogs beside English (Privacy Wallet Web spec §19; Stage 11; V6 Stage 16, spec v2.0 §18): Korean complete
// (./ko.ts, typed against every English key) and loaded as its own chunk when the locale needs it; Chinese and
// Japanese partial, typed against the English keys (a key they lack falls back to English, key by key) and registered
// at startup with the pseudo-locale for the layout checks.
import { en, type MessageKey } from "./en";
import { registerCatalog, type Catalog } from "./messages";
import { pseudoCatalog } from "./pseudo";

export const zh: Catalog = {
  "app.name": "隐私钱包",
  "nav.home": "首页", "nav.swap": "兑换", "nav.activity": "活动", "nav.more": "更多", "nav.wallet": "钱包",
  "route.swap": "兑换", "route.activity": "活动", "route.more": "更多", "route.receive": "接收", "protect.title": "保护资产", "route.privacy": "隐私中心", "route.security": "安全", "route.wallet": "钱包", "route.advanced": "高级", "route.classic": "经典隐私",
  "welcome.title": "保护您的金融隐私", "welcome.body": "钱包始终由您掌控。", "welcome.connect": "连接钱包", "welcome.noAccount": "无需账户", "welcome.skip": "不连接，继续",
  "common.continue": "继续",
};

export const ja: Catalog = {
  "app.name": "プライバシーウォレット",
  "nav.home": "ホーム", "nav.swap": "スワップ", "nav.activity": "履歴", "nav.more": "その他", "nav.wallet": "ウォレット",
  "route.swap": "スワップ", "route.activity": "履歴", "route.more": "その他", "route.receive": "受取", "protect.title": "資産を保護", "route.privacy": "プライバシーセンター", "route.security": "セキュリティ", "route.wallet": "ウォレット", "route.advanced": "詳細設定", "route.classic": "クラシックプライバシー",
  "welcome.title": "金融プライバシーを守る", "welcome.body": "ウォレットは常にあなたの管理下にあります。", "welcome.connect": "ウォレットを接続", "welcome.noAccount": "アカウント不要", "welcome.skip": "接続せずに続ける",
  "common.continue": "続ける",
};

/** The partial tables, registered at startup. */
export const CATALOGS: Record<string, Catalog> = { zh, ja };

/** The complete tables, each its own chunk (an English reader never downloads them). */
const LAZY: Record<string, () => Promise<Catalog>> = { ko: () => import("./ko").then((m) => m.ko) };
const loaded = new Set<string>();

/** Is the locale's table in memory: English, a partial table, the pseudo-locale, or a complete table already loaded. */
export const catalogReady = (locale: string): boolean => {
  const base = locale.split("-")[0];
  return !(base in LAZY) || loaded.has(base);
};

/** Loads and registers the locale's complete table, once; nothing for a locale without one. */
export async function loadCatalog(locale: string): Promise<void> {
  const base = locale.split("-")[0];
  const load = LAZY[base];
  if (!load || loaded.has(base)) return;
  registerCatalog(base, await load());
  loaded.add(base);
}

let registered = false;
/** Registers every catalog once (idempotent). */
export function registerCatalogs(): void {
  if (registered) return;
  registered = true;
  for (const [locale, catalog] of Object.entries(CATALOGS)) registerCatalog(locale, catalog);
  registerCatalog("pseudo", pseudoCatalog(en));
}

/** Every key of a partial catalog must be an English key (a typo would silently fall back). */
export function strayKeys(catalog: Catalog): string[] {
  return Object.keys(catalog).filter((k) => !(k in en));
}
export type { MessageKey };
