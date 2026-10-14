// Allowances (High-Value Protection spec §13; plan V3 §33–§34): the wallet never approves MAX_UINT256 — the shield
// approves the exact amount (sdk/privateTx.ts shieldERC20) — and what a failed deposit leaves behind can be read and
// revoked here. Reads and writes go through the injected wallet's OWN provider (never this wallet's RPC endpoints: no
// address ↔ endpoint link). The escrow's approval of the provider for its whole post-tip balance is bytecode and stays:
// invariant D1 bounds it to one tranche (documented in the audit package).
import { activeProvider } from "@privacy-wallet/wallet-engine/injected";
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from "viem";
import { sendViaInjectedWallet, type Deployment } from "./chain";
import { buildApprove, erc20Abi } from "./privacyProtocol";
import { assetsOf, type Asset } from "./assets";

type Injected = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
const injected = (): Injected | null => activeProvider(); // V5 (spec §7): the connection store's provider, the injected one as the fallback

/** `allowance(owner, spender)` read through the injected provider; null without one or on a refusal. */
export async function readAllowance(token: Address, owner: Address, spender: Address, eth: Injected | null = injected()): Promise<bigint | null> {
  if (!eth) return null;
  try {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
    const hex = await eth.request({ method: "eth_call", params: [{ to: token, data }, "latest"] });
    if (typeof hex !== "string" || !hex.startsWith("0x") || hex.length < 66) return null;
    return decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data: hex as Hex }) as bigint;
  } catch { return null; }
}

/** approve(spender, 0) from the connected wallet: the leftover of a failed deposit, or any allowance the user wants gone. */
export async function revokeAllowance(token: Address, spender: Address): Promise<Hex> {
  return sendViaInjectedWallet(buildApprove(token, spender, 0n));
}

/** `via`: whom the allowance lets pull the token — the asset's vault (a direct deposit) or ProtectRouter (V6, spec v2.0 §11.1). */
export interface AllowanceLine { asset: Asset; spender: Address; via: "vault" | "router"; allowance: bigint | null }

/** Every ERC-20 of the deployment with the connected account's allowance toward its vault and toward the protect router (null when unreadable). */
export async function allowancesFor(deployment: Deployment | null, owner: Address, eth: Injected | null = injected()): Promise<AllowanceLine[]> {
  const tokens = assetsOf(deployment).filter((a) => a.token);
  const spenders = (asset: Asset): { spender: Address; via: AllowanceLine["via"] }[] => [
    { spender: asset.vault as Address, via: "vault" },
    ...(deployment?.protectRouter ? [{ spender: deployment.protectRouter, via: "router" as const }] : []),
  ];
  return Promise.all(tokens.flatMap((asset) => spenders(asset).map(async ({ spender, via }) => ({ asset, spender, via, allowance: await readAllowance(asset.token as Address, owner, spender, eth) }))));
}
