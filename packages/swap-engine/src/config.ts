// Default engine wiring shared by the CLI and the local service: all six live adapters, the escrow
// creation code from the exported artifact, and the deployment parameters (env-overridable).
import { BYTECODE } from "@privacy-wallet/contracts";
import { PrivateSwapEngine } from "./engine";
import { ThorchainAdapter } from "./adapters/thorchain";
import { LifiAdapter } from "./adapters/lifi";
import { ChainflipAdapter } from "./adapters/chainflip";
import { MayanAdapter } from "./adapters/mayan";
import { NearIntentsAdapter } from "./adapters/nearIntents";
import { AcrossAdapter } from "./adapters/across";
import { NO_VALUER, RpcValuer } from "./valuation";

/** RPC_URLS="https://…,https://…" → the service's own Chainlink reads (whale spec §13); unset → every order is at least high-value. */
function valuerFromEnv(chainId: number) {
  const urls = (process.env.RPC_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return urls.length ? new RpcValuer(chainId, urls) : NO_VALUER;
}

/** ERC20_VAULTS="0xtoken:0xvault,0xtoken:0xvault" → the canonical vault a failed ERC-20 swap re-shields into (plan §36). */
function erc20RefundVaults(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of (process.env.ERC20_VAULTS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [token, vault] = entry.split(":").map((s) => s.trim());
    if (!/^0x[0-9a-fA-F]{40}$/.test(token ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(vault ?? "")) throw new Error(`ERC20_VAULTS entry "${entry}" must be 0xtoken:0xvault`);
    out[token.toLowerCase()] = vault;
    out[token] = vault;
  }
  return out;
}

export function defaultEngine(): PrivateSwapEngine {
  return new PrivateSwapEngine({
    adapters: [new ThorchainAdapter(), new LifiAdapter(), new ChainflipAdapter(), new MayanAdapter(), new NearIntentsAdapter(), new AcrossAdapter()],
    factory: process.env.SWAP_FACTORY ?? "0x0000000000000000000000000000000000000001", // placeholder until deployed; only affects the predicted address
    escrowCreationCode: BYTECODE.swapOrderEscrow, // @privacy-wallet/contracts: forge's export
    chainId: BigInt(process.env.CHAIN_ID ?? "1"),
    refundVaults: { native: process.env.NATIVE_VAULT ?? "0x0000000000000000000000000000000000000002", ...erc20RefundVaults() },
    tipBps: Number(process.env.TIP_BPS ?? "25"),
    refundWindowSeconds: Number(process.env.REFUND_WINDOW_SECONDS ?? String(2 * 3600)),
    valuer: valuerFromEnv(Number(process.env.CHAIN_ID ?? "1")),
  });
}
