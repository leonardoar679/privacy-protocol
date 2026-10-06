# Vendored: Poseidon2 (BN254, t = 4) — two independent implementations

Both compute the instance pinned in `docs/protocol-spec-v1.0.md §2` (t=4, R_F=8, R_P=56, HorizenLabs /
barretenberg constants, Noir sponge). Both are MIT. Neither is taken on trust: `test/hasher/Poseidon2Hasher.t.sol`
checks each against the nargo-generated vectors in the spec **and** against the other.

| File | Origin | sha256 of the original | Modification |
|------|--------|------------------------|--------------|
| `LibPoseidon2Yul.sol` | [zemse/poseidon2-evm](https://github.com/zemse/poseidon2-evm) `src/bn254/yul/LibPoseidon2Yul.sol` (generated Yul; `internal pure`, inlined, ~20k gas/permutation) | `5750e623f27c06d98b33adcaf3ac1a8d6f2b8503c5436d2113b5172f30c902e9` | none (verbatim) |
| `Poseidon2.sol` | [UseArclite/poseidon2-sol](https://github.com/UseArclite/poseidon2-sol) `src/Poseidon2.sol` (pure Solidity; `permute` exposes the full state, `hash` is the sponge) | `778bd9b70916a08984fa9a104c43105249bdbdcaef666bb72cefa7b15b456efc` | line 2: `pragma solidity ^0.8.28;` → `pragma solidity >=0.8.24;` (this project pins solc 0.8.24; the file uses no post-0.8.24 feature) |

Roles in `Poseidon2Hasher`:
- 1–3 inputs (Merkle nodes, owner commitment, commitment, nullifier — the hot paths): `LibPoseidon2Yul.hash_n`.
- 4–6 inputs (note body at deposit, phantom nullifier): `Poseidon2.hash`, because the Yul library only
  returns `state[0]` and the second absorb of the sponge needs the whole state.

Reduction note: `LibPoseidon2Yul` reduces inputs mod p; `Poseidon2Hasher` rejects any input `>= p`
before calling either library (canonical encoding, spec §1).

Related vendored files, same instance: `circuits/lib/poseidon2/{poseidon2,poseidon2_constants}.circom`
from `@taceo/circom-lib` 0.9.0 (MIT; sha256 `b990042c…9687fe` / `a2d2cb63…6fdc07`, verbatim; only the
`Poseidon2(4)` permutation is used, the Noir sponge is `circuits/lib/poseidon2_hash.circom`) and
`reference/typescript/src/poseidon2.ts` from UseArclite `ts/poseidon2.ts` (sha256 `c089dc1e…0e5f96`, verbatim).
