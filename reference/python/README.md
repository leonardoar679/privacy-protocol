# Python reference (plan §84 — differential implementation)

An independent implementation of the protocol primitives, written from `docs/protocol-spec-v1.0.md`
rather than ported from the TypeScript: Poseidon2 (BN254, t=4, Noir sponge), domain separators,
keys, note body / commitment / nullifier / phantom, payload and chain bindings, and the 4-aligned
Merkle accumulator. Pure Python 3, no dependencies (it carries its own Keccak-256; pycryptodome is
used if installed). Only the round constants are shared, generated from the vendored TypeScript by
`gen_constants.mjs` so nothing is hand-typed.

```
python test_vectors.py     # 31/31: nargo Poseidon2 vectors + circuits/vectors/primitives.json
node gen_constants.mjs     # regenerate poseidon2_constants.py from packages/protocol/src/poseidon2.ts
```
