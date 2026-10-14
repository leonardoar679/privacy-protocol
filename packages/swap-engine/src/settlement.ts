// The settlement of a swap's legs (spec v2.0 §12.4), the swap engine's browser-safe entry for it — the implementation
// lives in @privacy-wallet/protocol, shared with the wallet.
export { nextSettlement, settlementOf, type SettlementLegs } from "@privacy-wallet/protocol/wallet/settlement";
