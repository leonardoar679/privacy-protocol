# Wallet at-rest formats and key derivations — interoperability specification (V1.1)

Normative for every wallet of this protocol (web `frontend/`, the native wallets built on
`core/rust/privacy-core`): a backup made by one must open in another, the recovery phrase must give
the same seed everywhere, and the same addresses must come out on every chain. Pinned by
`reference/typescript/test/vectors/wallet.json` and `chainkeys.json`, which both the TypeScript and
the Rust implementations reproduce byte for byte (`frontend/test/wallet-vectors.test.ts`,
`core/rust/privacy-core/tests/wallet.rs`).

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
A swap record holds what the wallet needs to finish or refund an order without the swap service:
`orderId`, `attemptId` (the one-time order key is re-derived from the seed and it, never stored),
`refundCounter`, `refundNoteData` (the random 169-byte refund payload the order commits to), `provider`,
`policy`, `request` (`from`, `to`, `destination`: the reference every provider call is checked against
before signing), `params` (the on-chain OrderParams, from which the escrow address is recomputed),
`endpoint`, `approvedMin` (the least the user agreed to receive, destination base units; a call
guaranteeing less is signed only after fresh consent), `quote`, `createdAt`, `dueAt`, `fundedTx`,
`jobId`, `refunds` (the refund notes found for the order: `leafIndex`, `vault`, `amount`; `refund()` can
re-shield more than once), `state`.

The journal is readable only with the seed, never with the password alone. Losing the journal loses
nothing a chain rescan cannot rebuild except open swap orders and the fresh-address counters, which
is why the backup file includes it. Nothing in either file is ever stored in the clear; the only two
storage keys are `pp.keystore` and `pp.journal`.

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
