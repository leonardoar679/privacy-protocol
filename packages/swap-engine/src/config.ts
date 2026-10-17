// Default engine wiring shared by the CLI and the local service: all six live adapters, the escrow
// creation code from the exported artifact, and the deployment parameters (env-overridable).
import { BYTECODE } from "@privacy-wallet/contracts";
import { PrivateSwapEngine, type EngineConfig } from "./engine";
import { ThorchainAdapter } from "./adapters/thorchain";
import { LifiAdapter } from "./adapters/lifi";
import { ChainflipAdapter } from "./adapters/chainflip";
import { MayanAdapter } from "./adapters/mayan";
import { NearIntentsAdapter } from "./adapters/nearIntents";
import { AcrossAdapter } from "./adapters/across";
import { NO_VALUER, RpcValuer } from "./valuation";
import { RpcFeeSource, gasTips, type FeeSource } from "./tips";
import { pooledAssets } from "./escrowAssets";

const rpcUrls = () => (process.env.RPC_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** RPC_URLS="https://…,https://…" → the service's own Chainlink reads (whale spec §13); unset → every order is at least high-value. */
function valuerFromEnv(chainId: number) {
  const urls = rpcUrls();
  return urls.length ? new RpcValuer(chainId, urls) : NO_VALUER;
}

/** V6 (spec v2.0 §3): the executor tip is the execution's gas from eth_feeHistory on RPC_URLS; unset → no tip can be priced, no order. */
function feesFromEnv(): FeeSource {
  const urls = rpcUrls();
  return urls.length ? new RpcFeeSource(urls) : { fees: async () => { throw new Error("RPC_URLS is not set: the executor tip (the execution's gas) cannot be priced"); } };
}

/**
 * ERC20_VAULTS="0xtoken:0xvault[:SYMBOL:decimals],…" → the canonical vault a failed ERC-20 swap re-shields into (plan §36), and what
 * the token is: an order in it is built only under that symbol and those decimals (a V6 follow-up of 2026-10-16), which value its
 * tip; USDC and USDT on Ethereum need neither (escrowAssets.ts KNOWN_TOKENS). A malformed entry stops the start.
 */
function erc20RefundVaults(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of (process.env.ERC20_VAULTS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [token, vault, symbol, decimals, ...rest] = entry.split(":").map((s) => s.trim());
    const named = symbol === undefined || (/^[A-Za-z0-9.]{1,16}$/.test(symbol) && /^\d{1,2}$/.test(decimals ?? "") && Number(decimals) <= 36);
    if (!/^0x[0-9a-fA-F]{40}$/.test(token ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(vault ?? "") || !named || rest.length)
      throw new Error(`ERC20_VAULTS entry "${entry}" must be 0xtoken:0xvault or 0xtoken:0xvault:SYMBOL:decimals`);
    out[token.toLowerCase()] = vault;
    out[token] = vault;
  }
  return out;
}

/** A whole number of seconds from the environment, strictly: a malformed one stops the start (a V6 follow-up of 2026-10-15). */
function seconds(name: string, fallback: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < 60 || Number(raw) > max) throw new Error(`${name} must be a whole number of seconds from 60 to ${max}, not ${JSON.stringify(process.env[name])}`);
  return Number(raw);
}

export function defaultEngine(over: Partial<EngineConfig> = {}): PrivateSwapEngine {
  return new PrivateSwapEngine({
    adapters: [new ThorchainAdapter(), new LifiAdapter(), new ChainflipAdapter(), new MayanAdapter(), new NearIntentsAdapter(), new AcrossAdapter()],
    factory: process.env.SWAP_FACTORY ?? "0x0000000000000000000000000000000000000001", // placeholder until deployed; only affects the predicted address
    escrowCreationCode: BYTECODE.swapOrderEscrow, // @privacy-wallet/contracts: forge's export
    chainId: BigInt(process.env.CHAIN_ID ?? "1"),
    refundVaults: { native: process.env.NATIVE_VAULT ?? "0x0000000000000000000000000000000000000002", ...erc20RefundVaults() },
    // what the pool's assets are (a V6 follow-up of 2026-10-16): an order is built only in one of them, as the pool names it
    poolAssets: { native: { symbol: "ETH", decimals: 18 }, ...Object.fromEntries(pooledAssets()) },
    tips: gasTips(feesFromEnv(), valuerFromEnv(Number(process.env.CHAIN_ID ?? "1"))),
    refundWindowSeconds: seconds("REFUND_WINDOW_SECONDS", 2 * 3600, 30 * 86_400), // a NaN window gave every order a NaN refundAfter
    valuer: valuerFromEnv(Number(process.env.CHAIN_ID ?? "1")),
    ...over,
  });
}
