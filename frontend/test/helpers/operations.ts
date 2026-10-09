// A minimal operation record for the state-machine tests (spec §12).
import type { OperationRecord } from "../../src/wallet/operationRecord";

export const record = (over: Partial<OperationRecord> = {}): OperationRecord => ({
  id: "send:1", kind: "send", state: "DRAFT", createdAt: 1_000, updatedAt: 1_000,
  amounts: { asset: "ETH", decimals: 18, input: "1000000000000000000" }, fees: [], destination: { kind: "privacy-address", display: "pp1q…", chain: "ethereum" },
  refs: { txHashes: [] }, tier: "standard", history: [{ state: "DRAFT", at: 1_000 }], ...over,
});
