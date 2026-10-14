// Gas units of the contracts' paths (spec v2.0 §3): what the wallet shows before a protect and what the swap service's
// executor tip covers. Units only — a cost is always units × the live fee history (eth_feeHistory), never a fixed gas
// price. Each pin sits at or a few per cent above forge's measurement in the production configuration (real Poseidon2,
// depth 32, steady state: contracts/test/gas/PeripheryGasBench.t.sol → contracts/test/periphery/vectors/gas.json);
// test/gas.test.ts fails when a measurement exceeds its pin or a pin drifts more than 10 % above it.
export const GAS_UNITS = {
  /** a direct vault deposit (what the router wraps) */
  deposit: 1_600_000n,
  /** ProtectRouter.protectETH: the deposit, the fee transfer, the router's checks */
  protectETH: 1_620_000n,
  /** ProtectRouter.protectERC20: the pull, the fee transfer, the exact approval, the deposit */
  protectERC20: 1_680_000n,
  /** SwapOrderFactory.deployAndExecute of an ETH order with a minimal provider call (the provider's own call is added) */
  escrowExecuteETH: 1_900_000n,
  /** SwapOrderFactory.deployAndRefund of an ETH order: the escrow's deployment and the re-shielding deposit */
  escrowRefundETH: 3_450_000n,
} as const;

/** Not measured by the bench — a standard ERC-20 approve (an approval transaction before protectERC20), with headroom. */
export const ERC20_APPROVE_UNITS = 60_000n;

export type GasPath = keyof typeof GAS_UNITS;

/** A swap execution's provider call, beyond the bench's minimal one (a router deposit, a spoke pool, an aggregator's route). */
export const PROVIDER_CALL_UNITS = 150_000n;
/** An ERC-20 order's approval to the provider and its token transfers. */
export const ERC20_ORDER_UNITS = 80_000n;

/** The gas units of a swap order's execution: forge's deployAndExecute, the provider's call, an ERC-20's approval. */
export const executionUnits = (token: boolean): bigint => GAS_UNITS.escrowExecuteETH + PROVIDER_CALL_UNITS + (token ? ERC20_ORDER_UNITS : 0n);

export interface GasFees {
  baseFeePerGas: bigint;
  priorityFeePerGas: bigint;
}

/** ⌈units × (2·baseFee + priorityFee) × 1.2⌉ wei: room for six blocks of the base fee's largest rise. */
export const gasCeilingWei = (units: bigint, f: GasFees): bigint => (units * (2n * f.baseFeePerGas + f.priorityFeePerGas) * 12n + 9n) / 10n;
