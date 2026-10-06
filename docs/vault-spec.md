# Asset Vault Specification — V1

The vaults are the single biggest improvement over Tornado's shared-custody design: they isolate
each asset's issuer risk (§10–17, §81–82).

## One canonical vault per asset (§10, §12)
`AssetVaultFactory` deploys exactly one vault per asset via CREATE2 (`vaultOf[asset]` enforces
uniqueness; `isCanonical[vault]` is the core's authorization check). ETH uses the `address(0)`
sentinel → `NativeAssetVault`. Permissionless, ownerless. One vault per asset keeps that asset's
anonymity/liquidity from fragmenting across rival pools.

## Trust boundary (§64–66)
- The **core** holds nothing and calls only a canonical vault's `release` (it never calls a token).
- A **vault** obeys only its immutable `core` and holds only its immutable `asset` (spec §7).
- No third party: no operator, manager, relayer, governance, or admin. No `rescue`, `upgrade`,
  `changeToken`, or `changeCore`.

## Strict accounting (§15–16, fixes TC-19)
Deposits use a balance-delta check: `received == amount`, so **fee-on-transfer / rebasing /
reflection** tokens are rejected rather than mis-accounted. A direct token **donation** raises the
balance but not `accountedDeposits`, so it never becomes a spendable liability and no admin can
sweep it. Standard and no-return (USDT-style) tokens are supported; false-return tokens are rejected.

## Claimable-fallback payout (§38–39, fixes TC-11)
`release` is core-only and **never reverts on a failed transfer** — it books `claimable[recipient]`
and emits an event, so a reverting/blacklisted recipient cannot revert the completed state
transition or drain a relayer's gas. `claim(recipient)` later pushes the funds (permissionless). If
an issuer blacklist keeps blocking the transfer, the claim stays an obligation (§39) — the UI must
surface that distinction; the contract cannot override an issuer's policy.

## Solvency & isolation (§66, §82)
`isSolvent() = actualAssetBalance ≥ accountedDeposits + totalClaimable`, per vault. Formal
invariant: for every asset A, `Liability(A)` is backed only by `Vault(A)`, so an attack on
`Vault(USDT)` cannot alter `State(ETH)`, `State(USDC)`, or the core. Proven in
`contracts/test/issuer-risk/` and `contracts/test/invariants/`.
