// The primitive types every package shares (spec v2.0 §9–§10). No dependency: an address and a hex string are typed
// as template literals, compatible with viem's `Address` and `Hex`.

/** A 20-byte EVM address, `0x` + 40 hex characters. */
export type Address = `0x${string}`;

/** A hex string, `0x` + an even number of hex characters. */
export type Hex = `0x${string}`;

/** The chains the wallet names: where the pool lives (EVM) and where a swap may deliver. */
export type ChainId = "ethereum" | "sepolia" | "base" | "arbitrum" | "optimism" | "bitcoin" | "solana" | "local";

/** An amount in base units, as a decimal string (JSON-safe; bigint in memory). */
export type BaseUnits = string;
