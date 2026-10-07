// Default engine wiring shared by the CLI and the local service: all six live adapters, the escrow
// creation code from the exported artifact, and the deployment parameters (env-overridable).
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { PrivateSwapEngine } from "./engine";
import { ThorchainAdapter } from "./adapters/thorchain";
import { LifiAdapter } from "./adapters/lifi";
import { ChainflipAdapter } from "./adapters/chainflip";
import { MayanAdapter } from "./adapters/mayan";
import { NearIntentsAdapter } from "./adapters/nearIntents";
import { AcrossAdapter } from "./adapters/across";

export function defaultEngine(): PrivateSwapEngine {
  const escrowArtifact = JSON.parse(readFileSync(fileURLToPath(new URL("../../../contracts/abi/periphery/SwapOrderEscrow.json", import.meta.url)), "utf8"));
  return new PrivateSwapEngine({
    adapters: [new ThorchainAdapter(), new LifiAdapter(), new ChainflipAdapter(), new MayanAdapter(), new NearIntentsAdapter(), new AcrossAdapter()],
    factory: process.env.SWAP_FACTORY ?? "0x0000000000000000000000000000000000000001", // placeholder until deployed; only affects the predicted address
    escrowCreationCode: escrowArtifact.bytecode,
    chainId: BigInt(process.env.CHAIN_ID ?? "1"),
    refundVaults: { native: process.env.NATIVE_VAULT ?? "0x0000000000000000000000000000000000000002" },
    tipBps: Number(process.env.TIP_BPS ?? "25"),
    refundWindowSeconds: Number(process.env.REFUND_WINDOW_SECONDS ?? String(2 * 3600)),
  });
}
