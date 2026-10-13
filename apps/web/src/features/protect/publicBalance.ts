// The connected wallet's public balance in an asset (spec §3.4 "From … 0.84 ETH"), read through that wallet's OWN
// provider — never this wallet's RPC endpoints, so no address ↔ endpoint link is created (the allowances rule).
import { decodeAbiParameters, encodeFunctionData, type Address } from "viem";
import { activeProvider } from "@privacy-wallet/wallet-engine/injected";
import { erc20Abi } from "@privacy-wallet/sdk/privacyProtocol";

export async function readPublicBalance(account: string | null, token: Address | null): Promise<bigint | null> {
  const eth = activeProvider();
  if (!eth || !account) return null;
  try {
    if (!token) {
      const hex = await eth.request({ method: "eth_getBalance", params: [account, "latest"] });
      return typeof hex === "string" ? BigInt(hex) : null;
    }
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [account as Address] });
    const hex = await eth.request({ method: "eth_call", params: [{ to: token, data }, "latest"] });
    return typeof hex === "string" && hex.length >= 66 ? decodeAbiParameters([{ type: "uint256" }], hex as `0x${string}`)[0] : null;
  } catch {
    return null;
  }
}
