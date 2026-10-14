// The build environment's parsers (V6 Stage 16, spec v2.0 §19's budget): the deployment and the price feeds read from the
// VITE_* variables, with nothing that reads the chain — the platform's configuration runs them before the first screen,
// so the first route does not carry the chain client. ./chain.ts and ./prices.ts re-export them.
import type { Address } from "viem";
import type { FeedSpec } from "@privacy-wallet/protocol/wallet/valuation";
import { parseErc20Vaults } from "./assets";
import type { Deployment } from "./chain";

const isAddress = (v: string | undefined): v is Address => !!v && /^0x[0-9a-fA-F]{40}$/.test(v);

export function deploymentFromEnv(env: Record<string, string | undefined>): Deployment | null {
  const urls = String(env.VITE_RPC_URLS ?? env.VITE_RPC_URL ?? "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);
  if (!urls.length || !env.VITE_CORE || !env.VITE_ETH_VAULT) return null;
  const swapFactory = isAddress(env.VITE_SWAP_FACTORY) ? env.VITE_SWAP_FACTORY : undefined;
  const protectRouter = isAddress(env.VITE_PROTECT_ROUTER) ? env.VITE_PROTECT_ROUTER : undefined;
  const shieldFactory = isAddress(env.VITE_SHIELD_FACTORY) ? env.VITE_SHIELD_FACTORY : undefined;
  return {
    chainId: Number(env.VITE_CHAIN_ID ?? 31337),
    core: env.VITE_CORE as Address,
    ethVault: env.VITE_ETH_VAULT as Address,
    rpcUrl: urls[0],
    rpcUrls: urls,
    fromBlock: BigInt(env.VITE_FROM_BLOCK ?? 0),
    erc20Vaults: parseErc20Vaults(env.VITE_ERC20_VAULTS),
    swapFactory,
    ...(protectRouter ? { protectRouter } : {}),
    ...(shieldFactory ? { shieldFactory } : {}),
  };
}

export function feedsFromEnv(env: Record<string, string | undefined>): FeedSpec[] | null {
  const raw = env.VITE_PRICE_FEEDS;
  if (!raw) return null;
  const list = JSON.parse(raw) as FeedSpec[];
  if (!Array.isArray(list) || list.some((f) => !f.symbol || !f.description || !(f.heartbeatSeconds > 0) || !(f.proxy || f.registryBase)))
    throw new Error("VITE_PRICE_FEEDS must be a JSON array of { symbol, description, heartbeatSeconds, proxy | registryBase }");
  return list;
}
