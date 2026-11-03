// The deployment (doc §70–§71; spec v2.0 §10): which contracts this wallet talks to, and which versions they claim. A
// different fingerprint is a blocking notice, never a silent switch.
import type { Address, Hex } from "./primitives";

export interface ProtocolDeployment {
  chainId: number;
  /** "PROTOCOL_ID/CIRCUIT_ID/HASH_ID" as the core reports them (hex words) */
  protocolVersion: string;
  privacyCore: Address;
  verifier: Address;
  vaultFactory: Address;
  /** the Groth16 verifier behind the adapter, and its runtime code hash (the fifth review round, 2026-11-03): the key a deployment verifies with */
  innerVerifier?: Address;
  innerVerifierCodehash?: Hex;
  /** asset id → canonical vault */
  vaults: Record<string, Address>;
  swapFactory?: Address;
  protectRouter?: Address;
  shieldFactory?: Address;
  feeRecipient?: Address;
}

/** What the chain said about a deployment, condensed to one hash. */
export interface DeploymentFingerprint {
  chainId: number;
  /** keccak256 of the canonical JSON of the deployment as read from the chain */
  hash: Hex;
  /** what was read, for the Advanced view */
  read: ProtocolDeployment & { vaultVersion: number };
}
