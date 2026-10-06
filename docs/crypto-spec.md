# Cryptography Specification — V1 (summary; normative text in `protocol-spec-v1.0.md`)

## Field
BN254 scalar field `p = 21888242871839275222246405745257275088548364400416034343698204186575808495617`.
All public inputs are canonically encoded (`FieldLib.sol`, spec §1): `x < p`, `address < 2^160`,
`amount < 2^248`, `leafIndex < 2^32`. A value `>= p` is rejected, never reduced (field aliasing).

## Hash (spec §2) — pinned
**Poseidon2 / BN254, t = 4, R_F = 8, R_P = 56, Noir/barretenberg sponge** (rate 3, IV = n·2⁶⁴).
One instance, four implementations, one vector set (nargo/barretenberg v5.2.0):
- circuit: vendored TaceoLabs permutation + `circuits/lib/poseidon2_hash.circom` (Noir sponge);
- contracts: `Poseidon2Hasher` over vendored `LibPoseidon2Yul` (1–3 inputs) and `Poseidon2.sol` (4–6);
- TypeScript: vendored `poseidon2.ts`; Python: `reference/python/poseidon2.py` (independent).
Every one reproduces the ten nargo vectors and `circuits/vectors/primitives.json`
(`HASH_ID = keccak256("poseidon2-bn254-t4-rf8-rp56/noir-sponge/v1")`).

## Domain separation (spec §3)
`DOM(tag) = uint256(keccak256("privacy-protocol/v1/domain/<tag>")) % p` for
`NOTE_BODY, NOTE_COMMITMENT, OWNER_COMMITMENT, NULLIFIER, PHANTOM_NULLIFIER` (Poseidon2 prefixes) and
`OUTPUT_BINDING`, `TX_DOMAIN` (keccak prefixes). Identical across `DomainSeparators.sol`,
`reference/typescript/src/domains.ts`, `circuits/lib/domains.circom`, `reference/python/primitives.py`.

## Notes (spec §4–§5)
```
ownerCommitment = H(OWNER_COMMITMENT, spendKey)                      // receiving address; no on-chain registry (TC-17)
body            = H(NOTE_BODY, vaultId, amount, ownerCommitment, noteSecret)   // noteSecret random per note (PP-P01)
commitment      = H(NOTE_COMMITMENT, body, leafIndex)                 // contract assigns leafIndex → structural uniqueness
nullifier       = H(NULLIFIER, commitment, spendKey)                  // 1:1 with a funded note (fixes TC-22)
phantom_1       = H(PHANTOM_NULLIFIER, nullifier_0, 1, spendKey_0)    // unused input slot; unique, unrecomputable (PP-P02)
```
The 1:1 property holds because the spending circuit **derives** `ownerCommitment` from `spendKey`
(C4); the pre-audit draft took it as a free witness (PP-C01, critical, fixed). Dummy outputs use a
random owner commitment (no key, unspendable) and a random secret, so they are unique.

## Keys (spec §4)
`masterSeed → {spendKey, viewKey, noteKey}` derived locally; `noteSecret = keccak(noteKey ‖ counter) mod p`
for the wallet's own notes. The seed never leaves the device and is never persisted to dapp-origin
storage (the TC-01 fix; `frontend/src/keys/wallet.ts`).

## Bindings (spec §11–§12)
`txDomain = keccak256(abi.encode(keccak("…/TX_DOMAIN"), PROTOCOL_ID, chainId, core, CIRCUIT_ID)) mod p`
is public input 13; `noteDataHash_k = keccak256("…/OUTPUT_BINDING" ‖ noteData_k) mod p` binds each
169-byte payload to the proof.

## Proof system (spec §11; §41–42 of the plan still open)
Groth16/BN254 is the measured V1 baseline (~0.9 s proving, ~285k gas verify, 23,343 constraints);
the verifier is immutable behind `IProofVerifier`, so a universal/transparent system can replace it
without touching the public-input order. If Groth16 ships: a real multi-party ceremony with a public
beacon (TC-09/TC-20); the dev setup in this repo is insecure by design.
