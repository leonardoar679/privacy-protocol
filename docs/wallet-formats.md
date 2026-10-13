# Wallet at-rest formats and key derivations — interoperability specification (V1.1)

Normative for every wallet of this protocol (web `apps/web/`, the native wallets built on
`privacy-core/privacy-core`): a backup made by one must open in another, the recovery phrase must give
the same seed everywhere, and the same addresses must come out on every chain. Pinned by
`packages/protocol/test/vectors/wallet.json` and `chainkeys.json`, which both the TypeScript and
the Rust implementations reproduce byte for byte (`apps/web/test/wallet-vectors.test.ts`,
`privacy-core/privacy-core/tests/wallet.rs`).

## 1. Master seed and recovery phrase (plan §44)
- The master seed is 32 bytes from the platform CSPRNG. Every key derives from it (`keys.ts` / `keys.rs`:
  `spendKey / viewKey / noteKey = keccak256(seed ‖ "/spend" | "/view" | "/note") mod p`).
- The recovery phrase is the BIP-39 English mnemonic of those 32 bytes (24 words, 8-bit checksum).
  `mnemonicToEntropy(phrase)` MUST reproduce the seed exactly; the phrase is normalized NFKD, lower
  case, single spaces before use. The wordlist is `@scure/bip39/wordlists/english`; the Rust core
  embeds the same list (generated, sha256 of the newline-joined list recorded in the file header).
- The BIP-39 seed of the phrase (PBKDF2-HMAC-SHA512, 2048 rounds, salt `"mnemonic" ‖ passphrase`, empty
  passphrase by default) is the root of the chain keys (§3). It is NOT the master seed.

## 2. Keystore and journal (plan §44, TC-01)
```
keystore = { "v": 1, "kdf": { "name": "scrypt", "N": 65536, "r": 8, "p": 1, "dkLen": 32 },
             "salt": hex(16 bytes), "nonce": hex(24 bytes), "ct": hex(32 + 16 bytes) }
key      = scrypt(NFKD(password), salt, N, r, p, 32)          N ≥ 2^10 and a power of two; default 2^16
ct       = XChaCha20-Poly1305(key, nonce, aad = "privacy-protocol/v1/keystore")(seed)
```
A keystore that fails authentication is "wrong password": implementations MUST NOT distinguish a
wrong password from a tampered file. Unsafe parameters (N < 2^10, not a power of two, r or p < 1,
dkLen ≠ 32) MUST be refused before any work is done.
```
journal  = { "v": 1, "nonce": hex(24 bytes), "ct": hex }
key      = sha256("privacy-protocol/v1/journal-key" ‖ seed)
ct       = XChaCha20-Poly1305(key, nonce, aad = "privacy-protocol/v1/journal")(UTF-8 JSON)
plaintext JSON = { "v": 1, "notes": [...], "noteCounter": n, "chainIndexes": { chain: nextIndex },
                   "swaps": [...], "schedule": [...], "settings": {...} }     (bigints as decimal strings)
backup file = { "v": 1, "keystore": keystore, "journal": journal | null }
```
**V5 — where the records live (Privacy Wallet Web spec §8; Stage 2):** the only records of the secure store are
`pp.keystore` and `pp.journal` — and `pp.journal.unreadable` when a journal that would not decrypt was set aside — in the
IndexedDB database `privacy-wallet`, object store `secure` (a memory mirror hydrated before the first render; a browser
without IndexedDB keeps them in memory for the session). The `prefs` store (zod `PrefsV1`: the experience, the theme, the
locale, the recent network, the backup timestamps, the last connector, the first-launch flag; an unknown key is refused)
holds no secret and no financial figure. `localStorage` holds nothing of the wallet's: the one-time migration copied the
records, read them back byte for byte and only then removed the old keys. The plaintext journal's optional fields —
`activity`, `housekeeping`, `aiFunding`, `campaigns`, `addressBook`, `operations` (V5: the operation records from the
signature on, spec §12) and `classic` (V5: the Classic Privacy module's deposits, spec §16) — are never written by
`emptyJournal()`, so every earlier journal and the pinned vectors stay valid.
A swap record holds what the wallet needs to finish or refund an order without the swap service:
`orderId`, `attemptId` (the one-time order key is re-derived from the seed and it, never stored),
`refundCounter`, `refundNoteData` (the 169-byte refund payload the order commits to: `0x01` then
keccak256(seed ‖ "/refund-payload/" ‖ counter (4 bytes BE) ‖ i) for i = 0…5, truncated; derived, so a
rescan without the journal regenerates it), `provider`,
`policy`, `request` (`from`, `to`, `destination`: the reference every provider call is checked against
before signing), `params` (the on-chain OrderParams, from which the escrow address is recomputed),
`endpoint`, `approvedMin` (the least the user agreed to receive, destination base units; a call
guaranteeing less is signed only after fresh consent), `quote`, `createdAt`, `dueAt`, `fundedTx`,
`jobId`, `refundTokens` (tokens other than the order's asset the signed call may pay back to the
escrow; `address(0)` is ETH for an order in a token) with `refundFloors` (per token, the least balance
worth a re-shield after execution, base units; PP-S12), `refunds` (the refund notes found for the order:
`leafIndex`, `vault`, `amount`; `refund()` can re-shield more than once), `state`.

V3 (High-Value Protection spec §17) adds, all optional and never written by `emptyJournal()`: `campaigns` (one record per
protected execution: `id`, `state`, `mode`, `tier`, `request`, `bounds` — the execution bounds one confirmation binds —,
`plan`, `tranches` with their histories, `referenceRateE18`, `riskSnapshot`, `provider`, `policy`,
`gasPriceAtConfirmationWei`, `pause`, `pendingReroute`, `confirmations`, `alerts`, `lint`, `value`, `history`; bigints as
decimal strings), `addressBook` (the destination entries of spec §12: `id` = `<chain>:<canonical address, lowercase>`, `chain`, `address` as entered, `normalized`, `label`, `source` fresh | entered, `addedAt`, `lifecycle`, `verification { status, method, at }`, `coolingUntil`, `override { at, by }`, `lastUsedAt`, `usedBy`), `StoredSwap.campaign = { id, index }` on a
tranche's own order, the action kinds `campaign-tick` and `campaign-shape`, the activity kind `campaign`, and
`settings.protection`. A V2 journal round-trips byte for byte.

V4 (the High-Value Execution Engine contract, `docs/high-value-execution-contract-v1.0.md` §3) adds, all optional and
never written by `emptyJournal()`: on a tranche the state `destination-confirmed` (delivered, the finality margin running),
`lastReadFailedAt` (the last failed settlement read: "Unknown / reconnecting") and `fundedSeenAt` (the funding first seen in
the escrow by the quorum: a balance below the amount after it is a possible reorganization); on an address-book entry the
lifecycle `approved` with `approvedAt` (the user's approval for large payments; stale after 90 days idle); on
`settings.protection` the mode `best-execution`, `enabled` (the deliberate opt-out), `protectFromEnhanced`,
`providerShareCapBps`, `velocity { maxUsdPer24h }` and `introSeenAt`; the pause reason `velocity`. A V3 journal round-trips
byte for byte (`healProtection` fills the new settings with their defaults).

The journal is readable only with the seed, never with the password alone. Losing the journal loses
nothing a chain rescan cannot rebuild except open swap orders and the fresh-address counters, which
is why the backup file includes it. Nothing in either file is ever stored in the clear. V5 (Privacy Wallet Web
spec §8): the only secure-store records are `pp.keystore` and `pp.journal` (`pp.journal.unreadable` when one is set
aside), in the IndexedDB database `privacy-wallet`, store `secure` — moved once from localStorage, which then holds
nothing of ours; the `prefs` store beside it holds the experience mode, theme, locale and backup timestamps and never a
secret or a financial figure. The formats above are unchanged byte for byte.

## 3. Chain Key Abstraction (plan §45, §28, §37)
Root = BIP-32 master key of the BIP-39 seed (`"Bitcoin seed"` HMAC-SHA512).

| Chain | Path | Address |
|---|---|---|
| EVM (all networks share one account space) | `m/44'/60'/0'/0/i` | keccak256(uncompressed pubkey[1:])[12:], EIP-55 checksum |
| Bitcoin | `m/84'/0'/0'/change/i` | P2WPKH: bech32 (BIP-173) of version 0 ‖ ripemd160(sha256(compressed pubkey)), hrp `bc` |
| Solana | `m/44'/501'/i'/0'` (SLIP-0010 ed25519, hardened only) | base58(ed25519 public key) |
| per-dApp EVM account | `m/44'/60'/0'/0/j`, `j = keccak256("privacy-protocol/v1/dapp" ‖ lowercase(origin))[0..4] & 0x7fffffff` | as EVM |

Fresh addresses are handed out in index order; the next index per chain lives in the journal
(`chainIndexes`) and is reserved when an address is shown as a destination, so no address is reused.
The permanent public address of the user is never the default destination of anything.

## 4. Privacy address (spec §12, `docs/crypto-spec.md`)
bech32m, hrp `pp`, data `0x01 ‖ ownerCommitment(32) ‖ viewPub(32)`; 113 characters.

## 5. Vectors
`wallet.json`: a keystore with deterministic salt / nonce and N = 2^12, its phrase, a journal with its
key and nonce, three BIP-39 cases (12 and 24 words, with and without the `TREZOR` passphrase).
`chainkeys.json`: SLIP-0010 ed25519 test vectors 1 and 2, the BIP-84 first receive and change
addresses of the reference mnemonic, its BIP-44 Ethereum address and its Phantom Solana address.
