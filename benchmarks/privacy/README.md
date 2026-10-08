# Privacy benchmarks

The Tornado study's multi-channel adversary, applied to this protocol with the wallet policy that
ships (`reference/typescript/src/wallet/amounts.ts`). Results and reading: `docs/privacy-lab.md`.

```
node run.mjs                         # 8,000 users, 10/h, seed 4242 (≈1 min); writes results.json
node run.mjs --users 20000 --seed 7  # larger / different seed
```
Policies: P0 naive (Nova-like), C classic (fixed denominations), P1 standard, P2 high. Metrics per
withdrawal piece: effective anonymity set 2^H for the timing-only, amount-only and joint posteriors,
guess-hit (probability the single best guess is right), and the unique-link rate. Seeded and
dependency-free beyond `tsx`.

```
node run-crosschain.mjs              # the cross-chain observer lab (ingress ↔ arrival), incl. the streamed-settlement rows (V2); writes crosschain.json
node ../whale/run-utxo.mjs           # the whale UTXO strategy lab (V2 §74): one large piece vs many bucketed pieces; writes ../whale/utxo.json
```
