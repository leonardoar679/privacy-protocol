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
- A deposited note's own owner key (the audit round of 2026-10-16, c18): `ownerKey = keccak256(be32(spendKey) ‖
  "/owner-key/" ‖ be32(noteSecret)) mod p`, and the note is made out to `H(OWNER_COMMITMENT, ownerKey)`. Every protect,
  swap refund note and same-chain receipt is; transfers received and the wallet's private outputs (change, merged and
  split notes) keep the privacy address's owner commitment. A stored note's `ownerCommitment` selects its key: the spend
  key when it is the privacy address's, else the one derived from its secret (no new field; notes made before keep the
  privacy address's). A native wallet must spend and find such notes the same way (`docs/mobile.md`).
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
dkLen ≠ 32) MUST be refused before any work is done. A keystore has exactly these five fields, a 16-byte salt, a
24-byte nonce and a 48-byte ciphertext; anything else is not a keystore of this wallet's (the fifth review round,
2026-11-03; both cores refuse it since the seventh). The device's keystore is wrapped at the build's scrypt cost: a backup restored, or a stored keystore below
the configured N at an unlock, is encrypted again under a fresh salt and nonce — the file's own parameters never become
the device's.
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
locale — V6 Stage 16: with the optional `localeChosen`, the user's choice under Settings → Language, absent for
"Automatic" —, the recent network, the backup timestamps, the last connector, the first-launch flag; an unknown key is refused)
holds no secret and no financial figure. `localStorage` holds nothing of the wallet's: the one-time migration copied the
records, read them back byte for byte and only then removed the old keys. The plaintext journal's optional fields —
`activity`, `housekeeping`, `aiFunding`, `campaigns`, `addressBook`, `operations` (V5: the operation records from the
signature on, spec §12) and `classic` (V5: the Classic Privacy module's deposits, spec §16) — are never written by
`emptyJournal()`, so every earlier journal and the pinned vectors stay valid. V6 (spec v2.0 §12): an operation record
carries `v: 2` and the frozen vocabulary — `reason {code, fundsClass, detail?}` in place of `failure`, optional
`delayed {since, code}`, `declined {at, code}`, `settlement`, and (a V6 follow-up of 2026-10-14) optional `refs`
`noteCounter` (the note a Protect deposits or a Send makes as change), `nullifiers` (a Send's two, decimal) and
`relayerUrl`, kept at "submitting"; a V5 record is upgraded when the journal is decrypted
(`packages/sdk/src/operations/upgrade.ts`, idempotent) and written as V6 by the next write. A swap record's `track`
may carry `settlement` (where the money is, spec v2.0 §12.4), and the record itself `operationId` (V6 Stage 9: the API's
`op_` id of the order, from its commit or its first resume; spec v2.0 §15). V6 Stage 10 (spec v2.0 §10): the optional
`deploymentFingerprints` maps a chain id (a decimal string) to the deployment fingerprint the wallet saw before its
first operation there (`0x` + 64 hex, `packages/sdk/src/deploymentGuard.ts`); never written by `emptyJournal()`. V6
Stage 11 (spec v2.0 §7.6, §14.1): a swap order run by the order runner carries `runner { confirmedAt, delayUntil?,
maxTiming? }` (`maxTiming`, a V6 follow-up: funded at once from older notes only, each with its own timing at most it —
0, 0.3 or 0.7) and, while it waits, `paused { code, detail?, minOut?, approved?, at }` (on an order stopped unfunded
because its older notes no longer covered it, `older_notes_unavailable` with the state `abandoned`; on one whose relayer
does not run it, `relayer_not_ready` with the state `abandoned`, a V6 follow-up of 2026-10-16; on one confirmed under a
key the swap service no longer takes, `service_key_changed` with the state `abandoned`, the same follow-up; on one whose funding
was sent and never confirmed, `funding_unconfirmed`, a V6 follow-up; since 2026-10-14, on one whose execution window
closed before its funding, `order_expired` with the state `abandoned`, and on a funded one whose window closed before
its hand-over, `execution_window_closed`); a V6 follow-up of 2026-10-14: a swap order's
funding, journaled before it is sent, is `fundingAttempt { nullifiers: [decimal, decimal], by: "relayer" | "wallet",
relayerUrl?, txHash?, at }` (the transaction once known); its ticks are scheduled actions of the kind
`order-tick` (id `order-tick:<orderId>`); a note this wallet created carries `addedAt` (unix ms) — all optional. The
audit round of 2026-10-16: `countersHeld: true` while a journal that began without the whole of an earlier one (a restore
from the phrase or a backup) has had no complete scan — no note counter is handed out meanwhile (PP-P03); optional, never
written by `emptyJournal()`. Since the fifth review round (2026-11-03) the counters are held at every unlock as well, in
memory only, until the scan after it has read the pool: the cipher proves a journal is this seed's, never that it is the
newest (a profile restored from an older copy, a blob put back by a writer of the origin). A counter the scan finds that
the loaded journal did not know marks the journal stale and the 256 reserve applies at the release; a current journal
resumes where it was. A journal holds one note per leaf: one that holds a leaf twice (written before) loads once. A swap order may carry
`reviewedFee` (decimal, the relayer's fee for its funding the Review showed; c46): its funding never pays more. A
campaign's bounds may carry `minimumOutputNet` (decimal, 1e18 fixed point, per unit a step pays its provider — its escrow
less its own tip; c55): a step's price is checked on it when present, else on `minimumOutput`. A campaign may carry
`decidedAt` (unix ms of the user's last answer — pause, resume, a reroute's answer, return the rest; c36): a tick that ran
while it was given keeps it. A V6
follow-up (note discovery): a scheduled action of the kind `discovery` (id `discovery:pool`, one at a time, planned again
while unlocked), and an Activity line of the kind `receive` (a private transfer received, id `receive:<leafIndex>`). V6
Stage 12 (spec v2.0 §11.2): a same-chain swap into the protected balance carries `shield { factory, receiver, params
{ receiptId, asset, minAmount, shieldTip, ownerCommitment, noteSecret, noteDataHash, fallbackRecipient }, counter,
noteData, registeredAt?, job? { state, leafIndex?, txHash?, amount?, tip?, error?, at }, leaves? [{ leafIndex, vault,
amount }] }` (integers as decimal strings; `request.destination` is the receiver and `request.destinationType` is
`"protected"`); its note's payload is `0x01` then keccak256(seed ‖ "/shield-payload/" ‖ counter (4 bytes BE) ‖ i (one byte)) for
i = 0…5, truncated to 169 bytes — the refund payload's construction under its own domain, so a rescan without the
journal finds the delivery and tells it from a refund — optional, never written by `emptyJournal()`. A V6 follow-up
of 2026-10-16 (audit gap 47): a swap order carries `orderVouch` (65 bytes of hex), the swap service's vouch for the
order from its commit, shown at the finalize and handed to the relayer with a refund, and `shield.vouch`, its vouch for
the order's shield receipt, handed to the shield executor — optional, never written by `emptyJournal()`. V6 Stage 14 (spec
v2.0 §11.3): `classic` may also carry `relayer` (the id of the classic relayer the user chose). V6 Stage 15 (spec v2.0
§8, §14.3): `settings.autoLockMinutes` is one of 1, 5, 15 or 60 (absent reads as 15; any other value is dropped when the
settings are read), and `proofStats { keyMs, proveMs, keyCached, at }` keeps this device's last proof — the key's fetch
or cache read and the proving, in ms — so the next one's time can be estimated. Both are optional and never written by
`emptyJournal()`.
A swap record holds what the wallet needs to finish or refund an order without the swap service:
`orderId`, `attemptId` (the one-time order key — keccak256(seed ‖ "/order/" ‖ the attemptId as lowercase 0x-hex text),
reduced into [1, n − 1] of secp256k1 — is re-derived from the seed and it, never stored),
`refundCounter`, `refundNoteData` (the 169-byte refund payload the order commits to: `0x01` then
keccak256(seed ‖ "/refund-payload/" ‖ counter (4 bytes BE) ‖ i (one byte)) for i = 0…5, truncated; the vectors of both
payloads and of the order key are frozen in `packages/sdk/test/payload-vectors.test.ts`; derived, so a
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
aside; "Forget this wallet" removes all three — the audit's unverified m44, 2026-10-17: the set-aside one had stayed), in
the IndexedDB database `privacy-wallet`, store `secure` — moved once from localStorage, which then holds
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
`owner-keys.json` (`packages/protocol/src/genOwnerKeyVectors.ts`; audit round of 2026-10-16, c18): the owner key a
deposited note is made out to, `keccak256(be32(spendKey) ‖ "/owner-key/" ‖ be32(noteSecret)) mod p` (a 75-byte
preimage), and its owner commitment `H(OWNER_COMMITMENT, ownerKey)`, for the example seed's note secrets at counters 0,
1, 7, 255, 1024, 2^32 − 1 and 2^32 and for the secrets 0, 1 and p − 1; counter 1's preimage; a sample spend (body,
commitment, nullifier, phantom). Frozen: `packages/protocol/test/ownerKeys.test.ts` pins the file's SHA-256, the
generator refuses to write a different one, and `reference/python/test_vectors.py` and
`privacy-core/privacy-core/tests/wallet.rs` (`derive_owner_key`) reproduce it. No deposit is made
out to such a key yet; the wallet switches its deposits in a later follow-up.
