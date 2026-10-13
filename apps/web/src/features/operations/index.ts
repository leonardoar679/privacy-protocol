// The operation state machine (Privacy Wallet Web spec §12–§13): one vocabulary for every money flow.
export * from "@privacy-wallet/sdk/operations/types";
export { ALLOWED, DEFAULT_CODES, replay, transition } from "@privacy-wallet/sdk/operations/reducer";
export { CATALOG, CODES, classify, hasCode, reasonKey, titleKey, type CatalogRow, type Classified, type ErrorSource } from "@privacy-wallet/sdk/operations/errors/catalog";
export { ORDER_STATE_MAP, PAUSE_MAP, STORED_SWAP_MAP, SWAP_JOB_MAP, fromCampaign, fromStoredSwap, fromTranche, type Mapped } from "@privacy-wallet/sdk/operations/adapters";
export { ENGINE_EVENT_ORDER, engineListener, fromEngineEvent, type EngineEvent, type OnEvent } from "@privacy-wallet/sdk/operations/engineEvents";
export { allOperations, applyEvent, finishedOperations, getOperation, newOperation, newOperationId, openOperations, operationsOf, putOperation, removeOperation, resetOperationsMemory, type NewOperation } from "@privacy-wallet/sdk/operations/store";
export { actionWords, actionsFor, canRefund, fundsHeadline, needsAttention, progressWords, stateKey, stateWords, verdict, type Verdict } from "./recovery";
