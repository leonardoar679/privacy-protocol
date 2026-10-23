// The privacy leakage helpers (Privacy Wallet Web spec §20–§21; Stage 11): the secrets of a session in every textual
// form they could take, and the scan of a request body, a provider call or a console line for any of them — plus the
// field names that must never travel. Shared by the leakage suite and the swap scenario.
import { deriveKeys } from "@privacy-wallet/protocol/keys";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { seedToPhrase } from "@privacy-wallet/sdk/wallet/keystore";
import { secureStore } from "../../src/storage";

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Every textual form of a value: decimal and hex for a bigint, hex for bytes, the string itself. */
export function forms(x: unknown): string[] {
  if (typeof x === "bigint") { const h = x.toString(16); return [x.toString(10), h, "0x" + h, h.padStart(64, "0")]; }
  if (x instanceof Uint8Array) return [hex(x), "0x" + hex(x)];
  if (typeof x === "string") return [x];
  if (typeof x === "number") return [String(x)];
  return [];
}

export interface SecretSet { name: string; values: string[] }

/**
 * The secrets of the unlocked session: the seed, the phrase (as word triples), the derived keys, the password, every
 * journaled note's secret that is not a public deposit's (a shield's secret is on chain by design: it is listed apart),
 * the keystore's ciphertext and salt (no request should carry the stored blob either).
 */
export function sessionSecrets(o: { password: string; phrase?: string }): { secrets: SecretSet[]; shield: SecretSet } {
  const seed = session.state().seed!;
  const keys = deriveKeys(seed) as unknown as Record<string, unknown>;
  // the phrase is the seed's own words (audit round 2, n74): the pending one is gone once acknowledged, and the swap gates,
  // handed "" for it, searched for none of its words
  const words = (o.phrase || seedToPhrase(seed)).trim().split(/\s+/);
  if (words.length < 12) throw new Error("the leakage gate needs the phrase's words to search for them");
  const triples = words.slice(0, -2).map((_, i) => words.slice(i, i + 3).join(" "));
  const secrets: SecretSet[] = [
    { name: "the seed", values: forms(seed) },
    { name: "the phrase (three consecutive words)", values: triples },
    { name: "the password", values: [o.password] },
  ];
  for (const [k, v] of Object.entries(keys)) if (typeof v === "bigint" || v instanceof Uint8Array) secrets.push({ name: `the ${k}`, values: forms(v) });
  const notes = (session.journal().notes as unknown as { note?: { noteSecret?: string | bigint }; noteSecret?: string | bigint; label?: string; leafIndex?: number }[]) ?? [];
  const shield: SecretSet = { name: "a deposit note's secret", values: [] };
  for (const n of notes) {
    const raw = n.note?.noteSecret ?? n.noteSecret;
    if (raw === undefined) continue;
    const v = typeof raw === "bigint" ? raw : BigInt(raw);
    if (n.label === "shield") shield.values.push(...forms(v));
    else secrets.push({ name: `the note secret at leaf ${n.leafIndex} (${n.label ?? "private"})`, values: forms(v) });
  }
  const keystore = secureStore().get("pp.keystore");
  if (keystore) {
    const longHex = keystore.match(/[0-9a-f]{48,}/g) ?? [];
    if (longHex.length) secrets.push({ name: "the keystore's ciphertext or salt", values: longHex });
  }
  return { secrets, shield };
}

/** Field names that never travel in a request, whatever their value. */
export const FORBIDDEN_FIELDS = /^(seed|masterSeed|mnemonic|phrase|recoveryPhrase|password|spendKey|spendingKey|viewKey|viewingKey|noteKey|keystore|privateKey)$/i;

/** The field names of a JSON document, recursively. */
export function fieldNames(x: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(x)) for (const v of x) fieldNames(v, out);
  else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) { out.add(k); fieldNames(v, out); }
  return out;
}

/** The secrets a text contains, by name — empty when clean. */
export function leaks(text: string, secrets: SecretSet[]): string[] {
  const found: string[] = [];
  for (const s of secrets) for (const v of s.values) if (v.length >= 6 && text.includes(v)) { found.push(`${s.name} (${v.slice(0, 12)}…)`); break; }
  return found;
}
