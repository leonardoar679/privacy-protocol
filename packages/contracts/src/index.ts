// @privacy-wallet/contracts — the contract boundary (spec v2.0 §10).
export { ABI, BYTECODE } from "./abi";
export { ERC20_APPROVE_UNITS, ERC20_ORDER_UNITS, GAS_UNITS, PROVIDER_CALL_UNITS, executionUnits, gasCeilingWei, type GasFees, type GasPath } from "./gas";
export { canonicalJson, fingerprintHash, verifyDeployment, type DeploymentCheck, type DeploymentClaim, type DeploymentReader } from "./deployments";
