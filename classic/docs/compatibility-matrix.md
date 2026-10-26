# Tornado Classic — compatibility matrix (Workstream A)

V7 Stage 1 (2026-10-26). The source audit the owner's document asks for before anything is changed (doc §4.1, §4.3 A):
the pinned upstream sources and their licences, the artifacts and their hashes, the note and proof derivations, the
relayer protocol, the original interface's structure and words, what the original did that must NOT be copied, and
the corrections to the research study the Classic review had relied on. Everything here was read from the archived
clones beside this repository (`../tornado-classic-ui`, `../tornado-core`, `../tornado-relayer`,
`../reference/tornado-cli`, `../reference/websnark`, `../reference/circomlib`, `../reference/ui-minified`) and from
Ethereum mainnet through a public RPC endpoint and Sourcify (read-only). The normative text is
`../../docs/privacy-wallet-web-spec-v3.0.md` §7.

## 1. Pinned sources

| Repository (archived) | Commit | Date | Licence | Role here |
|---|---|---|---|---|
| tornadocash/tornado-classic-ui | `a83fae0772c8da084c0e76b3a756b456f5b9f5bb` | 2022-08-05 | MIT | the original interface's source (Nuxt 2.14.7, Vue 2, web3 1.5.2): the structure, the words, the flows |
| tornadocash/ui-minified | `7aeae4a53f2e3f1b13f21e5ed06f42c2ac94e80a` | 2022-08-05 | MIT (the UI's build) | the original interface's BUILT output — the parity reference (`reference/`); its generating commit's short id `617b461` is not in the archived master history, so the build itself is the pin |
| tornadocash/tornado-core | master `1ef6a263ac6a0e476d063fcb269a9df65a1bd56a` (2022-03-24); **the deployment-era tags v2.0 `7033f34434208cde40503a8daf71c1c0f8dab578` (2019-12-17) and v2.1 `a533ad9ffb62163a42d4fa9a09984c5dd4e5c41d` (2020-04-28)** | | LICENSE file GPL-3.0, SPDX headers MIT, package.json ISC | the contracts and the circuit; master is NOT the deployed source (§5) |
| tornadocash/tornado-cli | `378ddf8b8b92a4924037d7b64a94dbfd5a7dd6e8` | 2022-07-02 | ISC | the proving pipeline in one file (`cli.js`), the production artifacts (`build/circuits/`), the event caches to block 14,145,999, the per-pool deployed blocks (`config.js`) |
| tornadocash/tornado-relayer | `2247730603f2c249f90da0b07058325619435387` | 2022-05-25 | MIT | the relayer API and its fee rule |
| tornadocash/websnark | **phase2 commit `4c0af6a8b65aabea3c09f377f63c44e7a58afa6d`** (the UI's and the CLI's pin; the clone's HEAD `2041cfa5` is master) | 2020 | GPL-3.0 | the Groth16 prover (WASM) |
| tornadocash/snarkjs | `869181cfaf7526fe8972073d31655493a04326d5` (= npm `snarkjs@0.1.20`: `src/circuit.js`, `src/calculateWitness.js`, `src/bigint.js`, `src/stringifybigint.js` and `package.json` are byte-identical — checked 2026-10-26) | | GPL-3.0 | the witness calculator |
| tornadocash/circomlib | `3b492f9801573eebcfe1b6c584afe8a3beecf2b4` (tornado-cli's pin; tornado-core pins `c372f14d`, identical in `pedersenHash.js`, `babyjub.js`, `mimcsponge.js` and the circuits) | 2020-10-27 | GPL-3.0 | Pedersen, Baby Jubjub, MiMCSponge, the hasher generator |
| npm `circomlibjs@0.1.2` | the UI's hashing library (`buildPedersenHash`, `buildMimcSponge`) | | GPL-3.0 | equivalence with the circomlib fork to be vector-tested in Stage 6 before either is trusted |
| npm `fixed-merkle-tree@0.7.3` | the UI's tree (`0.6.x` in core and cli, `0.4.0` in the relayer) | | ISC | the tree semantics (`zeroElement`, `hashFunction`) |

**Licence consequence (the owner's decision 10, 2026-10-26):** the prover closure is GPL-3.0 and lives only in the
separately built `classic/` bundle, which carries a GPL-3.0 LICENSE and notices; the Privacy Wallet's packages are MIT.

## 2. The artifacts

| File | Bytes | sha256 | Where |
|---|---|---|---|
| `tornado.json` = `withdraw.json` (the circom-1 circuit) | 19,474,889 (LF) | `3ddd61dbff09caeec82d8edde95c674a3c34f9e66b1fe9f2c8783e72fe536f98` | `../reference/tornado-cli/build/circuits/` (the Windows working copy is CRLF-converted: 20,162,376 B, sha256 `3967123c…` — never pin that), inside `tornado.json.zip` of classic-ui `static/` and ui-minified (zip sha256 `2e3529280b9dc9a1655dc78dfe53344d519e712106828f7abcf29711081191c6`; inner file dated 2020-08-13, CRC 6636e396) |
| `tornadoProvingKey.bin` = `withdraw_proving_key.bin` | 14,522,256 | `8e2d2f22beafb5a9666daebca57b13f8029c3656c65fcfbcc86e2418fa16a3af` | the same three places (zip sha256 `8372d2b40b83a798b2f6f44c98588ab254aaf4f1abcbf31581fd40712f76ba68`; inner file dated 2020-08-31, CRC 6ad07015) |

Circuit facts (parsed from `tornado.json`): nVars 28,300, constraints 28,275, nSignals 36,528, 6 public inputs,
42 private inputs, 2,342 components, 39 templates and 1 function (JavaScript source strings the snarkjs-0.1 witness
calculator `eval`s at `circuit.js:46` and `:53` — the Classic app precompiles them at build time, spec §7.3). The
circuit is the v2.1 one: it carries the four hidden squares `recipientSquare`, `feeSquare`, `relayerSquare`,
`refundSquare` (signals 28,296–28,299). Proving-key header: nVars 28,300, nPublic 6, domainSize 32,768; its `alfa1`,
`beta2` and `delta2` equal the constants of `Verifier.sol` (`gamma2` and `IC` are not in a websnark key — only a proof
the deployed verifier accepts settles them, Stage 6). Provenance (participants, transcript, phase-1 source) is not
recorded anywhere in the clones; the research study's `10-audits/historical` is empty.

**The websnark pin matters:** `git diff 4c0af6a8 2041cfa5 -- src/ tools/` is four files — `src/bn128.js` builds the
FFT with the fixed non-residue `bigInt(7)` (`buildFFT(moduleBuilder, "fft", "frm", bigInt(7))`, line 50), `src/build_fft.js`
takes that `overrideNr` instead of searching for a non-residue, `tools/buildpkey.js` and `tools/buildwasm.js` follow.
A prover built from master proves with another root of unity and the production key rejects it. Closure hashes at
`4c0af6a8` (sha256, first 16 hex): `src/groth16.js` 715466cd17ee6f09, `src/utils.js` 0441ef88c50121d8,
`tools/stringifybigint.js` 5053c72386313a8c, `build/groth16_wasm.js` f3dfe57eeb393d1a.

## 3. The note and the derivations (tornado-cli `cli.js`, classic-ui `utils/crypto.js`, tornado-core `circuits/withdraw.circom`)

- Note: `tornado-<currency>-<amount>-<netId>-0x<124 hex>`; the hex is `nullifier (31 bytes, little-endian) ‖ secret
  (31 bytes, little-endian)`, both from `crypto.randomBytes(31)` (`rbigint`). The CLI parses it with an unanchored
  `/tornado-(\w+)-([\d.]+)-(\d+)-0x([0-9a-fA-F]{124})/` and accepts a `tornadoInvoice-…` form; the UI splits on `-` and
  checks index 4 for 126 characters of `0x` + hex. Backup file name `backup-tornado-<currency>-<amount>-<netId>-<first
  10 hex>.txt`.
- `commitment = pedersenHash(nullifierLE31 ‖ secretLE31)`, `nullifierHash = pedersenHash(nullifierLE31)`, where
  `pedersenHash(data) = babyJub.unpackPoint(circomlib.pedersenHash.hash(data))[0]` (the x coordinate), rendered as
  32-byte hex. The circuit computes the same: `Pedersen(496)` over `Num2Bits(248)(nullifier) ‖ Num2Bits(248)(secret)`
  and `Pedersen(248)` over the nullifier bits; `hasher.nullifierHash === nullifierHash`.
- Tree: `MerkleTreeChecker(20)`; leaves hashed with MiMCSponge (`hashLeftRight`, 220 rounds, key 0, constants from a
  keccak256 chain seeded `mimcsponge`); zero leaf `keccak256("tornado") mod p` =
  `21663839004416932945382355908790599225266501822907911457504978515578255421292`; `FIELD_SIZE` =
  `21888242871839275222246405745257275088548364400416034343698204186575808495617`.
- Public inputs in order: `root, nullifierHash, recipient, relayer, fee, refund`; private: `nullifier, secret,
  pathElements[20], pathIndices[20]`. Proof = `websnark.utils.genWitnessAndProve(groth16, input, circuit, provingKey)`
  then `toSolidityInput(proof).proof`: `0x` + eight 32-byte words `a0 a1 b01 b00 b11 b10 c0 c1` (512 hex). Contract args:
  `[toHex(root), toHex(nullifierHash), toHex(recipient, 20), toHex(relayer, 20), toHex(fee), toHex(refund)]`; for ETH
  pools `refund = 0`, `fee ≤ denomination`. Wallet mode: the UI sets `relayer = recipient`, the CLI `relayer = 0`; both
  with `fee = 0`.
- Spent: the pool's `isSpent(bytes32)` / `isSpentArray` (the CLI reads it; the UI only searched Withdrawal events).

## 4. The relayer protocol (tornado-relayer `src/`, tornado-cli `cli.js`, classic-ui `store/relayer.js`)

- `GET /status` (also `/v1/status`): `{ rewardAccount, instances, netId, ethPrices, tornadoServiceFee (a percent,
  0.05 means 0.05 %), miningServiceFee, version, health: { status: 'true' | 'false' (STRINGS from Redis), error,
  errorsLog }, currentQueue }`.
- `POST /v1/tornadoWithdraw` (alias `/relay`): `{ proof: 0x + 512 hex, contract: a pool address in the relayer's
  allowlist, args: [root, nullifierHash, recipient, relayer == rewardAccount, fee, refund] }`, no extra properties →
  `200 { id }` or `400 { error }`.
- `GET /v1/jobs/:id`: the job (`id, type, status, proof, args, contract, txHash, confirmations, failedReason`); states
  `QUEUED → ACCEPTED → SENT → MINED → CONFIRMED`, `RESUBMITTED` (a replaced transaction), `FAILED`; `400` for an
  unknown id. The UI polled every 3 s, retried 5 times on an error, gave up after 15 minutes.
- Fee rule: the relayer requires `fee ≥ gasPrice × 390,000 + amount × tornadoServiceFee / 100` (no maximum); the UI
  estimated `denomination × fee % / 100 + maxFeePerGas × 550,000`, the CLI `gasPrice × 500,000 + amount × fee %`. The
  UI's schema caps `tornadoServiceFee` at 20. The relayer submits `router.withdraw(contract, proof, …args)` with gas
  limit 700,000 and `value = refund`, waits 4 confirmations, does no SNARK check, no `eth_call` preflight and no
  `isSpent`/`isKnownRoot` read before sending.
- Discovery (the UI): `RelayerRegistered` events of the registry (from block 14,173,129; the registry subgraph first,
  RPC second), the Aggregator's `relayersData` (owner match, registered, ≥ 40 TORN staked, the ENS `mainnet-tornado`
  TXT host), then `GET /status` on each host: `currentQueue ≤ 5`, `netId` match, `rewardAccount` match, the schema,
  version `5.0.0` or `4.x` with patch ≥ 4 (or a beta ≥ 11); the choice weighted by stake and fee.

## 5. The deployed pools against the sources (Workstream B's starting point; the full verification is Stage 5)

| Fact | Deployed (mainnet, 2026-10-26) | tornado-core master | v2.0 / v2.1 |
|---|---|---|---|
| compiler | solc 0.5.11+commit.c082d0b4, optimizer 200 (Sourcify: `TornadoCash_Eth_01` for the 0.1 pool, `TornadoCash_eth` for the 1 ETH pool; the 10 and 100 pools share the 1 ETH pool's runtime code); the verifier solc 0.5.17 | `pragma ^0.7.0`, solc 0.7.6 | `pragma ^0.5.8` (v2.0), 0.5.17 (v2.1) |
| `ROOT_HISTORY_SIZE` | **100** on all four | 30 | 100 |
| the hasher | a linked `library Hasher` (circomlib `mimcsponge_gencontract`, 220 rounds) | an `IHasher` constructor argument | `library Hasher` |
| the operator | `operator() = 0x0` on all four (renounced) | no operator | `operator`, `updateVerifier`, `changeOperator` (no events) |
| the verifier | `0xce172ce1f20ec0b3728c9965470eaf994a03557a`, shared | `Verifier.sol` "reverted to the deployed one" (commit f5d8f6d; header "generated by trusted setup ceremony", Etherscan 2020-05-12) | a symlink to the local build output |
| the circuit | the v2.1 circuit (the squares) — the deployed verifier accepts the production key's proofs | identical to v2.1 | v2.0 lacks the squares |
| router | `TornadoRouter` `0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b` (solc 0.6.12, Sourcify exact match), `governance() = 0x5efda50f22d34F262c29268506C5Fa42cB56A1Ce`, `instanceRegistry() = 0xb20c66c4de72433f3ce747b58b86830c459ca911` with all four pools `ENABLED`, protocol fee 0.30 % on the 1/10/100 pools and 0 on the 0.1 pool; `relayerRegistry() = 0x58E8dCC13BE9780fC42E8723D8EaD4CF46943dF2` | not in any clone (the predecessor `TornadoProxy.sol` is in `../reference/tornado-anonymity-mining`) | — |
| deployed blocks | 9,116,966 / 9,117,609 / 9,117,720 / 9,161,895 (tornado-cli `config.js`; the UI uses one network block 9,116,966) | | |
| deposits today | 75,154 / 96,432 / 78,767 / 49,612 (`nextIndex()`); balances 629 / 4,321 / 23,340 / 282,400 ETH | | |

**Event caches available as seeds:** classic-ui `static/events/deposits_eth_<d>.json.zip` (`[{timestamp, commitment,
blockNumber, transactionHash, leafIndex}]`) and `withdrawals_eth_<d>.json.zip` (`[{to, fee, blockNumber, nullifierHash,
transactionHash}]`, written newest-first) to about block 14,954,102 (June 2022; leaves 22,653 / 46,177 / 40,920 /
27,543), the trees as `static/trees/deposits_eth_<d>_{bloom,slice1..4}.json.zip` (`fixed-merkle-tree` `getTreeSlices(4)`:
`{edge, elements, metadata}`); tornado-cli `cache/ethereum/{deposits,withdrawals}_eth_<d>.json` (plain JSON) with
18,363 / 35,194 / 31,160 / 21,596 deposits from blocks 9,117,019 / 9,117,802 / 9,118,009 / 9,162,622 to 14,145,999 at the
latest. Every seed is data to be re-verified against the live root (spec §7.4), never trusted.

## 6. The original interface (ui-minified, served locally; the screenshots and the text inventory in `reference/`)

One page `/` with the **Deposit | Withdraw** tabs (Buefy `b-tabs`; no deposit or withdraw URL), the **Statistics**
panel beside them ("Anonymity set", "Latest deposits") and the transaction / job history below; the Account, Compliance
and Governance pages; a geofenced `451.html`. The deposit tab: Token (ETH), Amount (0.1 · 1 · 10 · 100 as steps), the
tooltip "Each amount is a standalone Tornado Cash instance with a separate anonymity set. Check the Stats tab for more
info.", Connect / Deposit → the note modal: "Your private note", "Please back up your note. You will need it later to
withdraw your deposit.", "Treat your note as a private key - never share it with anyone, including tornado.cash
developers.", "The browser will ask to save your note as a file:" (desktop only), the checkbox "I backed up the note",
"Your note won't be saved in your browser. Please make sure it's backed up!", "Send Deposit". The withdraw tab: "Note"
("Please enter the note you received after deposit was made" / "Please enter your note"), on a valid note "Time passed"
and "Subsequent deposits" (warnings under 24 h or under 5 deposits: "The most likely source of a withdrawal points to
recent deposits. Therefore, we recommend allowing at least 5 deposits after yours for better anonymity."), "Recipient
Address" ("Please paste address here"), "Donate", the settings modal with the Relayer | Wallet tabs (the wallet-mode
warning "Make sure that {currency} used to pay for the gas fee is not linkable to ANY of your addresses. Otherwise, the
anonymity of the withdrawal will be compromised. We recommend using a Relayer instead."), "Total" / "Note balance" / "Gas
Price" / "Network fee" / "Relayer fee" / "Total fee" / "Tokens to receive", "Withdraw" → "Generating proof" → "Withdrawal
Confirmation": "Your zk-Snark proof has been successfully generated! Please click Confirm to initiate the withdrawal",
"Confirm". Errors: "Note is invalid", "Note has been spent", "There is no related deposit. The note is invalid.", "Your
note is from another network, please change network in the app." History words: "Waiting for receipt", "Failed",
"Spent", "Deposited". The compliance warning: "Do not share your Note with anyone since it WILL be used to withdraw your
funds!". Languages: en, es, fr, ru, tr, uk, zh. Layout: desktop-first (the viewport meta disables zoom).

## 7. What the original did that the Classic app must NOT copy

| Original behaviour | Why not | Classic app |
|---|---|---|
| the raw note persisted in `localStorage` (`txHashKeeper`, `relayer.jobs`) through `vuex-persistedstate` on trusted hosts | TC-01 of the research: a plaintext bearer secret at rest | never stored (spec §7.8) |
| the note, its commitment and its nullifier hash logged to the console on entry and on deposit | a secret in the console | nothing logged |
| the proving artifacts downloaded from the site or IPFS gateways without a hash check | a swapped artifact | pinned by sha256, cached by hash |
| `connect-src *`, `script-src 'unsafe-eval' 'unsafe-inline'` | the eval of the circuit's templates; any host | templates precompiled; a strict policy |
| an Infura project key and WalletConnect bridge baked into the bundle (`_nuxt/*.js`) | third-party credentials in the client | the operator's own RPC endpoints, configured at build |
| an optional encrypted note published on chain through the router's third argument and the Echo contract ("note account") | a second copy of the secret, keyed to an account | not offered |
| the compliance PDF printing the full note | a secret in a document | not offered |
| spent status from Withdrawal events only | incomplete history reads an unspent note as spent, or a spent one as unspent, and the transaction then reverts | the verified history first, the on-chain `isSpent` before a withdrawal |
| the backup file skipped on mobile user agents | the only safe first backup | the file first on every device, the clipboard second |
| the sanctions-oracle redirect at connect and the Netlify geofence | a legal decision, not an engineering default | implemented behind switches, off until the owner's legal review (decision 9) |

## 8. Corrections to the research study the Classic review relied on

| Claim (`../../research`, `docs/classic-privacy-review.md`) | Finding |
|---|---|
| "the 30-root history window" (TC-10) | the live pools have `ROOT_HISTORY_SIZE() = 100`; 30 is master's value after commit 3ad6345 (2021-03-11) |
| "no owner, upgrade or pause" (TC-P1) proved on master | the deployed source has an operator with `updateVerifier`; the claim holds on chain because `operator()` is `0x0` on all four pools (renounced), read 2026-10-26 |
| "master = the same on-chain bytecode" | the deployed pools are solc 0.5.11 builds of the v2.0-era source; master is 0.7.6 |
| websnark clone "4c0af6a8" | the clone's HEAD is `2041cfa5` (master); `4c0af6a8` is in its history and is the production pin |
| relayer cache lag causes Classic reverts (TC-14) | the relayer's tree watcher is mining-only; the lag that matters is the client's event cache |
| the timing figures (10 deposits/hour) | assumed rates; the Classic app computes "deposits since yours" and "time passed" from the pool's own events |

## 9. What the Classic app reuses, and from where

The note parser twin of `packages/protocol/src/classic/note.ts` (the same vectors); the vendored prover closure (§2);
the relayer schemas of the former in-app module, corrected for the string health and `RESUBMITTED`; the design tokens
as a generated stylesheet; the original's words (§6) under the Classic word policy; the research's findings as
requirements (§7). Nothing of the original's Nuxt code runs inside the Privacy Wallet (doc §9).
