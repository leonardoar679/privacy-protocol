// Wallet-side key material (spec §42–44). THE RULE: the raw spending secret / master seed is NEVER
// written to dapp-origin localStorage (the direct fix for TC-01). This stub keeps the seed in
// memory only; a real wallet uses an OS keystore / hardware-backed key / encrypted backup.
// The keys themselves derive in one place, the guarded one (@privacy-wallet/protocol/keys deriveKeys: no key from a seed a lock zeroed or a
// public one; the eleventh review round, 2026-11-04, VG11-N1 — an unguarded copy here had stayed importable).

export function generateMasterSeed(): Uint8Array {
  const s = new Uint8Array(32);
  crypto.getRandomValues(s); // full-entropy CSPRNG — the one thing Tornado got right (keep it)
  return s;
}

/**
 * Guard used across the app: refuse to persist anything that looks like raw secret material in
 * dapp-origin storage. (A real wallet routes secrets to an OS/hardware keystore instead.)
 */
export function assertNotPersistingSecret(key: string): void {
  if (/seed|secret|spend|private|note-?key/i.test(key)) {
    throw new Error(`Refusing to persist secret-like key "${key}" to dapp-origin storage (TC-01 guard).`);
  }
}
