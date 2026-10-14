// The catalogs beside English (Privacy Wallet Web spec §19; Stage 11): Korean, Chinese and Japanese tables, partial and
// typed against the English keys (a key they lack falls back to English, key by key), and the pseudo-locale for the
// layout checks. Registered once, at startup. The partial tables cover the shell and the first screens; the full
// translations are a later pass (the plan's out-of-scope list) and need no code change: a key added here is used.
import { en, type MessageKey } from "./en";
import { registerCatalog, type Catalog } from "./messages";
import { pseudoCatalog } from "./pseudo";

export const ko: Catalog = {
  "app.name": "프라이버시 지갑",
  "nav.home": "홈", "nav.swap": "스왑", "nav.activity": "활동", "nav.more": "더보기", "nav.wallet": "지갑",
  "route.swap": "스왑", "route.activity": "활동", "route.more": "더보기", "route.receive": "받기", "protect.title": "자산 보호", "route.privacy": "프라이버시 센터", "route.security": "보안", "route.wallet": "지갑", "route.advanced": "고급", "route.classic": "클래식 프라이버시",
  "welcome.title": "금융 프라이버시를 보호하세요", "welcome.body": "지갑은 언제나 당신의 통제 아래 있습니다.", "welcome.connect": "지갑 연결", "welcome.noAccount": "계정이 필요 없습니다", "welcome.skip": "연결하지 않고 계속",
  "common.continue": "계속",
};

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

export const CATALOGS: Record<string, Catalog> = { ko, zh, ja };

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
