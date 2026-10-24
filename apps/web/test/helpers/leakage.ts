// The privacy leakage helpers (Privacy Wallet Web spec §20–§21; Stage 11): the secrets of a session in every textual
// form they could take, and the scan of a request body, a provider call or a console line for any of them — plus the
// field names that must never travel. Shared by the leakage suite and the swap scenario.
import { deriveKeys } from "@privacy-wallet/protocol/keys";
import type { Note } from "@privacy-wallet/protocol/note";
import { ownerKeyOf } from "@privacy-wallet/sdk/keys/ownerKeys";
import { deriveOrderKey } from "@privacy-wallet/sdk/keys/swapKeys";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { seedToPhrase } from "@privacy-wallet/sdk/wallet/keystore";
import { secureStore } from "../../src/storage";

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
/** base64 and base64url, unpadded: a secret encoded so had matched none of the hex forms (audit round 2, n80) */
const base64s = (b: Uint8Array): string[] => {
  const std = Buffer.from(b).toString("base64").replace(/=+$/, "");
  return [std, std.replace(/\+/g, "-").replace(/\//g, "_")];
};
const be32 = (x: bigint): Uint8Array => Uint8Array.from(Buffer.from(x.toString(16).padStart(64, "0").slice(-64), "hex"));

/** Every textual form of a value: decimal, hex and base64 for a bigint (32 bytes, big-endian), hex and base64 for bytes, the string itself. */
export function forms(x: unknown): string[] {
  if (typeof x === "bigint") { const h = x.toString(16); return [x.toString(10), h, "0x" + h, h.padStart(64, "0"), ...base64s(be32(x))]; }
  if (x instanceof Uint8Array) return [hex(x), "0x" + hex(x), ...base64s(x)];
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
  const notes = (session.journal().notes as unknown as { note?: { noteSecret?: string | bigint; ownerCommitment?: string | bigint; vaultId?: string | bigint; amount?: string | bigint }; noteSecret?: string | bigint; label?: string; leafIndex?: number }[]) ?? [];
  const shield: SecretSet = { name: "a deposit note's secret", values: [] };
  const spendKey = (keys as { spendKey: bigint }).spendKey;
  for (const n of notes) {
    const raw = n.note?.noteSecret ?? n.noteSecret;
    if (raw === undefined) continue;
    const v = typeof raw === "bigint" ? raw : BigInt(raw);
    if (n.label === "shield") shield.values.push(...forms(v));
    else secrets.push({ name: `the note secret at leaf ${n.leafIndex} (${n.label ?? "private"})`, values: forms(v) });
    // a deposited note's own owner key (the audit round of 2026-10-16, c18; audit round 2, n80): secret even where its
    // note secret is public by design
    if (n.note?.ownerCommitment !== undefined) {
      const big = (x: unknown) => (typeof x === "bigint" ? x : BigInt(String(x ?? 0)));
      const note: Note = { vaultId: big(n.note.vaultId), amount: big(n.note.amount), ownerCommitment: big(n.note.ownerCommitment), noteSecret: v };
      const key = ownerKeyOf({ spendKey }, note);
      if (key !== null && key !== spendKey) secrets.push({ name: `the owner key of the note at leaf ${n.leafIndex}`, values: forms(key) });
    }
  }
  // every journaled order's one-time key (n80): it signs the order's execution
  for (const s of session.journal().swaps ?? []) secrets.push({ name: `the one-time key of order ${s.orderId.slice(0, 10)}`, values: forms(BigInt(deriveOrderKey(seed, s.orderId as `0x${string}`).privateKey)) });
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

/** The secrets a text contains, by name — empty when clean. Read in any case (audit round 2, n80): hex was matched lowercase only. */
export function leaks(text: string, secrets: SecretSet[]): string[] {
  const found: string[] = [];
  const lower = text.toLowerCase();
  for (const s of secrets) for (const v of s.values) if (v.length >= 6 && lower.includes(v.toLowerCase())) { found.push(`${s.name} (${v.slice(0, 12)}…)`); break; }
  return found;
}
