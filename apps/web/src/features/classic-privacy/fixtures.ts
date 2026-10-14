// Classic Privacy on fixtures (V6 Stage 14; the screenshot harness): the devnet's three pools, a pool's status, a deposit
// recovered from a pasted note, the relayer choice with one relayer offline. Fixed data; nothing is computed or fetched.
import type { ClassicHomeModel, ClassicPoolStatusModel, ClassicRecoverModel, ClassicRelayerLine } from "./View";

export const CLASSIC_HOME_FIXTURE: ClassicHomeModel = {
  available: true,
  pools: [
    { id: "eth-0.1", amount: "0.1", symbol: "ETH", size: "1482.3 ETH", deposits: 14_823, mine: 0 },
    { id: "eth-1", amount: "1", symbol: "ETH", size: "1482 ETH", deposits: 1_027, mine: 2 },
    { id: "eth-10", amount: "10", symbol: "ETH", size: "2130 ETH", deposits: 213, mine: 0 },
  ],
};

export const CLASSIC_POOL_FIXTURE: ClassicPoolStatusModel = {
  size: "1482 ETH",
  deposits: 1_027,
  rootAgeSeconds: 95,
  health: "ready",
  relayer: "relayer.devnet.local",
  relayerFeePercent: 0.3,
  mine: "2 × 1 ETH",
};

export const CLASSIC_RECOVER_FIXTURE: ClassicRecoverModel = {
  noteText: "tornado-eth-1-31337-0x5a1c…",
  result: { ok: true, pool: "1 ETH", status: "ready", leaf: 1027, journaled: false },
};

export const CLASSIC_RELAYERS_FIXTURE: { relayers: ClassicRelayerLine[]; chosen: string } = {
  relayers: [
    { id: "relayer.devnet.local", name: "relayer.devnet.local", feePercent: 0.3, status: "online" },
    { id: "relayer.backup.local", name: "relayer.backup.local", feePercent: 0.4, status: "offline" },
  ],
  chosen: "relayer.devnet.local",
};
