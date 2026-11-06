// The deployment check (doc §71; spec v2.0 §10): what the chain says the configured contracts are — the core's protocol,
// circuit and hash identifiers, its verifier and vault factory, the canonical vault of every registry asset and its
// version — condensed to a fingerprint. The wallet remembers the fingerprint it first saw for a chain; a different one
// is a blocking notice ("This app does not match the deployed protocol."), never a silent switch.
import {
  AbiDecodingDataSizeTooSmallError,
  AbiDecodingZeroDataError,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import type { DeploymentFingerprint, ProtocolDeployment } from "@privacy-wallet/protocol-types";
import devVerifier from "../../../contracts/abi/dev/TransactionVerifierDev.json";
import hasherRuntime from "../../../contracts/abi/runtime/Poseidon2Hasher.json";

const ZERO = "0x0000000000000000000000000000000000000000";

const CORE_ABI = [
  { type: "function", name: "PROTOCOL_ID", stateMutability: "pure", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "CIRCUIT_ID", stateMutability: "pure", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "HASH_ID", stateMutability: "pure", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "VERIFIER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "VAULT_FACTORY", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "LEVELS", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "HASHER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const HASHER_ABI = [{ type: "function", name: "poseidon2", stateMutability: "pure", inputs: [{ type: "uint256[]" }], outputs: [{ type: "uint256" }] }] as const;
const WRAPPED_ABI = [{ type: "function", name: "WRAPPED_NATIVE", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const VERIFIER_ABI = [{ type: "function", name: "INNER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const FACTORY_ABI = [{ type: "function", name: "vaultOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] }] as const;
const VAULT_ABI = [{ type: "function", name: "VAULT_VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;
const SHIELD_FACTORY_ABI = [{ type: "function", name: "VAULT_FACTORY", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;

/** The two reads the check needs (a viem PublicClient satisfies it; tests pass a fake). */
export interface DeploymentReader {
  getChainId(): Promise<number>;
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  /** the code at an address (viem's getCode); without it the inner verifier's code is not read (a test's reader) */
  getCode?(args: { address: Address }): Promise<Hex | undefined>;
}

/** The development verifier's runtime code hash: a key that accepts any proof, for devnets only (the fifth review round, 2026-11-03). */
export const DEV_VERIFIER_CODEHASH: Hex = keccak256(devVerifier.deployedBytecode as Hex);
/**
 * The development key itself (the eleventh review round, 2026-11-04, G11-4): its delta and IC points, which every compilation of the verifier
 * template embeds as 32-byte immediates — the code hash recognised one compilation alone, and the same insecure key built with another
 * toolchain (a metadata trailer suffices) passed. Exported from TransactionVerifierDev.sol by export-abi.mjs.
 */
export const DEV_KEY_WORDS: readonly Hex[] = (devVerifier as { keyWords: string[] }).keyWords as Hex[];
/** Whether code embeds the development key: one of its words as a byte-aligned run of the code. */
export const holdsDevKey = (code: Hex): boolean =>
  DEV_KEY_WORDS.some((w) => {
    const body = code.toLowerCase().slice(2);
    const word = w.toLowerCase().slice(2);
    for (let i = body.indexOf(word); i >= 0; i = body.indexOf(word, i + 1)) if (i % 2 === 0) return true;
    return false;
  });
/**
 * This build's protocol, circuit and hash identifiers (contracts/src/core/CoreTypes.sol; the eleventh review round, G11-1): a core of another
 * protocol, circuit or hash had passed the check, its identifiers read and compared with nothing — every deposit into it locked for good.
 */
export const CORE_IDS = {
  protocolId: keccak256(stringToHex("privacy-protocol/v1.0")),
  circuitId: keccak256(stringToHex("privacy-protocol/v1/circuit/transaction-2in3out-depth32-poseidon2")),
  hashId: keccak256(stringToHex("poseidon2-bn254-t4-rf8-rp56/noir-sponge/v1")),
} as const;
/** This build's Poseidon2 hasher's runtime code hash (no immutables: a constant of the pinned build; export-abi.mjs). */
export const HASHER_CODEHASH: Hex = keccak256(hasherRuntime.deployedBytecode as Hex);
/** poseidon2([1, 2, 3]) of this build's hash — three inputs, the rate's own case (the sponge's last permutation skipped): the hasher read back. */
export const POSEIDON2_ONE_TWO_THREE = 0x23864adb160dddf590f1d3303683ebcb914f828e2635f6e85a32f0a1aecd3dd8n;
/** The chain's wrapped native token, as both factories must take it (the eleventh review round, G11-6); a chain absent here: any but none,
 * save the devnet (chain id 31337), where the deploy scripts take none (DeploySwapPeriphery.s.sol, DeployShieldReceiver.s.sol). */
const DEVNET_CHAIN_ID = 31337;
export const WRAPPED_NATIVE_OF: Readonly<Record<number, Address>> = {
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH9 (the local stack places it at this address too)
  11155111: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", // Sepolia WETH
};
/** The circuit's depth: Transaction(32, 2, 3); a core built at another depth can never verify a spend. */
export const CIRCUIT_LEVELS = 32;

export interface DeploymentClaim {
  chainId: number;
  core: Address;
  /** asset id → token address (null = the native asset); each must have a canonical vault */
  assets: Record<string, Address | null>;
  swapFactory?: Address;
  protectRouter?: Address;
  shieldFactory?: Address;
  feeRecipient?: Address;
  /** a production build (the fifth review round, 2026-11-03): the development verifier is a problem there, never on a devnet */
  production?: boolean;
}

export interface DeploymentCheck {
  fingerprint: DeploymentFingerprint;
  /** what does not hold: a wrong chain, an asset without a vault, a vault of another version */
  problems: string[];
  /** a fingerprint was remembered for this chain and this one differs */
  changed: boolean;
}

const lower = (a: string): Address => a.toLowerCase() as Address;

/** The chain's own answer that an address is not the contract asked (no code, a revert, no data or too little) — not a failed read. */
export const notThatContract = (e: unknown): boolean =>
  e instanceof BaseError &&
  !!e.walk(
    (x) =>
      x instanceof ContractFunctionZeroDataError ||
      x instanceof ContractFunctionRevertedError ||
      x instanceof AbiDecodingZeroDataError ||
      x instanceof AbiDecodingDataSizeTooSmallError,
  );

/** Canonical JSON: keys sorted at every level, addresses lowercase (two reads of the same deployment hash the same). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) return JSON.stringify(v.toLowerCase());
  return JSON.stringify(v);
}

export const fingerprintHash = (read: DeploymentFingerprint["read"]): Hex => keccak256(stringToHex(canonicalJson(read)));

/** Reads the deployment a configuration claims and compares it with what the wallet remembered for that chain. */
export async function verifyDeployment(client: DeploymentReader, claim: DeploymentClaim, remembered?: Hex | null): Promise<DeploymentCheck> {
  const problems: string[] = [];
  const chainId = await client.getChainId();
  if (chainId !== claim.chainId) problems.push(`the endpoints answer chain ${chainId}, the configuration names chain ${claim.chainId}`);
  const core = claim.core;
  const read = (functionName: (typeof CORE_ABI)[number]["name"]) => client.readContract({ address: core, abi: CORE_ABI, functionName });
  const [protocolId, circuitId, hashId, verifier, vaultFactory, levels, hasher] = (await Promise.all([
    read("PROTOCOL_ID"),
    read("CIRCUIT_ID"),
    read("HASH_ID"),
    read("VERIFIER"),
    read("VAULT_FACTORY"),
    read("LEVELS"),
    read("HASHER"),
  ])) as [Hex, Hex, Hex, Address, Address, bigint, Address];
  // this build's protocol, circuit and hash (the eleventh review round, G11-1): another's core takes a deposit no proof of this build can spend
  if (protocolId.toLowerCase() !== CORE_IDS.protocolId) problems.push(`the core's protocol identifier ${protocolId} is not this build's`);
  if (circuitId.toLowerCase() !== CORE_IDS.circuitId)
    problems.push(`the core's circuit identifier ${circuitId} is not this build's circuit: no proof of this build can verify`);
  if (hashId.toLowerCase() !== CORE_IDS.hashId) problems.push(`the core's hash identifier ${hashId} is not this build's`);
  // and its hasher: the build's code, and read back on the rate's own case — another hasher's commitments are notes no scan finds
  const hasherCode = client.getCode ? await client.getCode({ address: hasher }) : undefined;
  if (client.getCode && (!hasherCode || hasherCode === "0x")) problems.push(`the core's hasher ${hasher} has no code`);
  else if (hasherCode && keccak256(hasherCode).toLowerCase() !== HASHER_CODEHASH.toLowerCase())
    problems.push(`the core's hasher ${hasher} is not this build's Poseidon2`);
  const heard = (await client.readContract({ address: hasher, abi: HASHER_ABI, functionName: "poseidon2", args: [[1n, 2n, 3n]] }).catch((e: unknown) => {
    if (notThatContract(e)) return null;
    throw e;
  })) as bigint | null;
  if (heard !== POSEIDON2_ONE_TWO_THREE) problems.push(`the core's hasher ${hasher} does not hash as this build's Poseidon2`);
  // the depth and the key behind the adapter (the fifth review round, 2026-11-03): the fingerprint had named the adapter's address and
  // nothing of the inner Groth16 verifier — the ceremony's or the development one, which accepts any proof —, nor the tree's depth,
  // which the core takes from 3 to 32 while the circuit is fixed at 32 (a wrong depth locks every spend for good)
  if (Number(levels) !== CIRCUIT_LEVELS) problems.push(`the core's tree depth is ${levels}, the circuit's is ${CIRCUIT_LEVELS}: no proof can ever verify`);
  const inner = (await client.readContract({ address: verifier, abi: VERIFIER_ABI, functionName: "INNER" })) as Address;
  const innerCode = client.getCode ? await client.getCode({ address: inner }) : undefined;
  const innerCodehash: Hex | null = innerCode && innerCode !== "0x" ? keccak256(innerCode) : null;
  if (client.getCode && innerCodehash === null) problems.push(`the proof verifier's inner key ${inner} has no code`);
  // the key, not one compilation of it (the eleventh review round, G11-4)
  if (claim.production && innerCode && innerCode !== "0x" && (innerCodehash?.toLowerCase() === DEV_VERIFIER_CODEHASH.toLowerCase() || holdsDevKey(innerCode)))
    problems.push("the proof verifier is the development key, which accepts any proof: not a deployment to use");
  const vaults: Record<string, Address> = {};
  let vaultVersion = 0;
  for (const [id, token] of Object.entries(claim.assets).sort(([a], [b]) => a.localeCompare(b))) {
    const vault = (await client.readContract({ address: vaultFactory, abi: FACTORY_ABI, functionName: "vaultOf", args: [token ?? ZERO] })) as Address;
    if (lower(vault) === ZERO) {
      problems.push(`no canonical vault for ${id}`);
      continue;
    }
    vaults[id] = lower(vault);
    const v = Number(await client.readContract({ address: vault, abi: VAULT_ABI, functionName: "VAULT_VERSION" }));
    if (vaultVersion && v !== vaultVersion) problems.push(`the vault of ${id} is version ${v}, the others ${vaultVersion}`);
    vaultVersion ||= v;
  }
  // V6 Stage 12 (spec v2.0 §11.2): a shield receiver deposits into its factory's pool — it must be this core's
  if (claim.shieldFactory) {
    // a read that failed is the read's own error, tried again next time, as every other read here (audit round 2, n41): any
    // error had read as "no pool", a blocking "This app does not match the deployed protocol"; only the chain's own answer —
    // no contract there, a revert, no data — names the address as no shield receiver factory of this pool
    const pool = (await client.readContract({ address: claim.shieldFactory, abi: SHIELD_FACTORY_ABI, functionName: "VAULT_FACTORY" }).catch((e: unknown) => {
      if (notThatContract(e)) return null;
      throw e;
    })) as Address | null;
    if (!pool || lower(pool) !== lower(vaultFactory))
      problems.push(`the shield receiver factory deposits into ${pool ?? "no pool"}, not this core's vault factory ${vaultFactory}`);
  }
  // both factories take the chain's wrapped native token (the eleventh review round, G11-6): a shield factory built on none let anyone sweep
  // an ETH receipt's WETH to the public fallback, and a swap factory on another refunds nothing it unwraps
  for (const [name, factory] of [
    ["shield receiver", claim.shieldFactory],
    ["swap", claim.swapFactory],
  ] as const) {
    if (!factory) continue;
    const wrapped = (await client.readContract({ address: factory, abi: WRAPPED_ABI, functionName: "WRAPPED_NATIVE" }).catch((e: unknown) => {
      if (notThatContract(e)) return null;
      throw e;
    })) as Address | null;
    const want = WRAPPED_NATIVE_OF[chainId];
    if (!wrapped || lower(wrapped) === ZERO) {
      if (chainId !== DEVNET_CHAIN_ID) problems.push(`the ${name} factory ${factory} takes no wrapped native token`);
    } else if (want && lower(wrapped) !== lower(want))
      problems.push(`the ${name} factory ${factory} takes ${wrapped} as the wrapped native token, not this chain's ${want}`);
  }
  const deployment: ProtocolDeployment = {
    chainId,
    protocolVersion: `${protocolId}/${circuitId}/${hashId}`,
    privacyCore: lower(core),
    verifier: lower(verifier),
    vaultFactory: lower(vaultFactory),
    vaults,
    innerVerifier: lower(inner),
    ...(innerCodehash ? { innerVerifierCodehash: innerCodehash.toLowerCase() as Hex } : {}),
    ...(claim.swapFactory ? { swapFactory: lower(claim.swapFactory) } : {}),
    ...(claim.protectRouter ? { protectRouter: lower(claim.protectRouter) } : {}),
    ...(claim.shieldFactory ? { shieldFactory: lower(claim.shieldFactory) } : {}),
    ...(claim.feeRecipient ? { feeRecipient: lower(claim.feeRecipient) } : {}),
  };
  const fingerprint: DeploymentFingerprint = { chainId, hash: fingerprintHash({ ...deployment, vaultVersion }), read: { ...deployment, vaultVersion } };
  return { fingerprint, problems, changed: !!remembered && remembered.toLowerCase() !== fingerprint.hash.toLowerCase() };
}
