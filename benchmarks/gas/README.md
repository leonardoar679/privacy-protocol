# Gas benchmarks — and what they cost right now

Gas is measured once (forge); **price is never hard-coded**. `cost.mjs` multiplies the measured gas by
the live Ethereum gas price (`eth_feeHistory`: next base fee + median priority of the last 5 blocks,
from a public RPC) and the live ETH/USD (Coinbase spot), and compares against the plan's §79 targets.

```
node cost.mjs                     # live prices
node cost.mjs --gwei 0.233        # what-if gas price
node cost.mjs --eth-usd 3000      # what-if ETH price
node cost.mjs --json              # machine-readable
RPC_URL=… ETHERSCAN_API_KEY=… node cost.mjs   # your own RPC; adds the Etherscan gas oracle line
```

## Sample run (2026-10-06, live)
```
gas price : 0.154 gwei  (base 0.114 + priority 0.040)      ETH/USD: $2,715.09
operation                           gas         ETH         USD       §79 target
deposit (ETH shield)                1,519,179   0.000234    $0.64     150k (10.1x)
deposit (ERC-20 shield)             1,560,000   0.000240    $0.65     200k (7.8x)
private transaction (transfer)      1,794,176   0.000276    $0.75     650k (2.8x)
withdrawal (transact + release)     1,830,000   0.000282    $0.77     750k (2.4x)
Groth16 verify alone                285,523     0.000044    $0.12
Poseidon2 (2 inputs, external call) 28,193      0.000004    $0.01
Poseidon2 (5 inputs, external call) 183,021     0.000028    $0.08
```
At today's gas a private transaction is well under a dollar. The §79 gas *targets* are still not met
(2.4–10×); they are engineering targets, and here is where the gas goes.

## Measured (steady state, real Poseidon2, depth 32)
Source: `contracts/test/gas/GasBench.t.sol` (`forge test --match-contract GasBench -vv`) and
`contracts/test/verifier/Groth16RealProof.t.sol`; details in `measurements.json`.

| Operation | Gas | Of which |
|---|---|---|
| `deposit` (ETH) | **1,519,179** | 32 Merkle hashes × ~28k ≈ 0.90M · 5-input body hash 183k · commitment 28k · storage/events ≈ 0.3M |
| `transact` | 1,511,653 + verify | 33 Merkle hashes ≈ 0.93M · 3 commitments 85k · storage (2 nullifiers, root, subtrees, 3×169 B events) ≈ 0.4M |
| Groth16 verify | 285,523 | 14 public inputs on the BN254 precompiles |
| first call after deployment | +60k | cold `filledSubtrees` slots; `cost.mjs` uses steady state |

Versus the previous implementation (circomlib Poseidon, 96 hashes per transaction): `transact`
4.44M → **1.79M (−60%)**, `deposit` 1.71M → **1.52M (−11%)**. The 4-aligned leaf groups and the
Poseidon2 Yul library did that; the deposit is dominated by its 32 unavoidable path hashes.

## Levers (benchmark before freezing)
1. **Call the hash libraries directly** instead of through the external `IHasher` call: the call,
   ABI encoding and the field checks cost ~8k per hash → ~−260k per `transact`, ~−250k per deposit.
   Trades away the hasher's pluggability (and the mock-based test design).
2. **Yul full-state permutation for the 5-input body** (deposit only): the pure-Solidity sponge
   costs 183k for two permutations vs ~40k in Yul → ~−140k per deposit.
3. **Deposit queue + batched insertion**: append commitments to a queue (one SSTORE) and insert up to
   4 at once in a later group — the only way to get a *deposit* near §79's 150k, at the cost of
   delayed inclusion and someone paying for the batch. Needs a design decision.
4. **Shallower tree** (24–26 levels): −6…8 hashes per insert; changes the circuit and needs a new setup.
5. **ZK-proven tree updates** (rollup style): biggest saving, biggest architectural change.

## Notes
- `Groth16RealProofTest:test_MalformedProofPointRejected` shows ~1.02B gas: a failed BN254 pairing
  precompile consumes **all** gas forwarded to it (EIP-197), so the figure is the test's gas limit.
  On mainnet the burn is bounded by the submitter's own gas limit; relayers MUST simulate before
  submitting (PP-O01 in `docs/circuit-audit.md`).
- The mock suites (`core/ vault/ adversarial/ …`) use the keccak `MockHasher` and a depth-10 tree;
  their gas is not representative. `gas-snapshot.txt` is the per-test snapshot of the whole suite.
