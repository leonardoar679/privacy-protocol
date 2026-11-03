// @privacy-wallet/contracts — the contract boundary (spec v2.0 §10).
export { ABI, BYTECODE } from "./abi";
export { ERC20_APPROVE_UNITS, ERC20_ORDER_UNITS, GAS_UNITS, PROVIDER_CALL_UNITS, executionUnits, gasCeilingWei, type GasFees, type GasPath } from "./gas";
export {
  canonicalJson,
  CIRCUIT_LEVELS,
  DEV_VERIFIER_CODEHASH,
  fingerprintHash,
  verifyDeployment,
  type DeploymentCheck,
  type DeploymentClaim,
  type DeploymentReader,
} from "./deployments";
export {
  SHIELD_TIP_DIVISOR,
  RECEIVER_PARAMS_TUPLE,
  encodeReceiverParams,
  predictReceiver,
  receiverInitCodeHash,
  receiverParamsJson,
  receiverParamsOf,
  receiverParamsProblem,
  shieldMinAmount,
  type ReceiverParams,
  type ReceiverParamsJson,
} from "./shield";
