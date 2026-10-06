// Thin SDK over the immutable contracts (ABI frozen in docs/protocol-spec-v1.0.md §14). Deposits
// (public shields) are built fully; the private `transact` builder is intentionally STUBBED —
// client-side proof generation is a later stage and must run locally (Web Worker), never by
// shipping the secret to a server.
import { type Address, type Hex, encodeFunctionData, parseAbi } from "viem";

/** Fixed-size encrypted output payload (spec §12). */
export const NOTE_DATA_BYTES = 169;

export const coreAbi = parseAbi([
  "function commitDeposit(uint256 ownerCommitment, uint256 noteSecret, uint256 amount, bytes noteData) returns (uint32)",
  "function transact(bytes proof, (uint256 root, uint256 nullifier0, uint256 nullifier1, uint256 outputBody0, uint256 outputBody1, uint256 outputBody2, uint256 mode, uint256 withdrawalVault, uint256 withdrawalAmount, uint256 withdrawalRecipient, uint256 noteData0Hash, uint256 noteData1Hash, uint256 noteData2Hash, uint256 txDomain) pi, bytes noteData0, bytes noteData1, bytes noteData2)",
  "function noteDataHash(bytes noteData) pure returns (uint256)",
  "function currentRoot() view returns (bytes32)",
  "function nextLeafIndex() view returns (uint32)",
  "function isKnownRoot(bytes32 root) view returns (bool)",
  "function isNullifierSpent(uint256 nullifier) view returns (bool)",
  "function VAULT_FACTORY() view returns (address)",
  "function TX_DOMAIN() view returns (uint256)",
  "function PROTOCOL_ID() view returns (bytes32)",
  "function CIRCUIT_ID() view returns (bytes32)",
  "function HASH_ID() view returns (bytes32)",
  "event NoteInserted(uint32 indexed leafIndex, uint256 commitment, bytes noteData)",
  "event ShieldedTransaction(uint256 nullifier0, uint256 nullifier1, uint256 commitment0, uint256 commitment1, uint256 commitment2)",
]);

export const factoryAbi = parseAbi([
  "function vaultOf(address asset) view returns (address)",
  "function isCanonical(address vault) view returns (bool)",
  "function predictNativeVault() view returns (address)",
  "function predictERC20Vault(address token) view returns (address)",
]);

export const nativeVaultAbi = parseAbi([
  "function deposit(uint256 ownerCommitment, uint256 noteSecret, bytes noteData) payable returns (uint32)",
  "function claim(address recipient)",
  "function claimable(address recipient) view returns (uint256)",
]);

export const erc20VaultAbi = parseAbi([
  "function deposit(uint256 amount, uint256 ownerCommitment, uint256 noteSecret, bytes noteData) returns (uint32)",
  "function claim(address recipient)",
  "function claimable(address recipient) view returns (uint256)",
]);

export interface TxRequest {
  to: Address;
  data: Hex;
  value?: bigint;
}

function requireNoteData(noteData: Hex): void {
  if ((noteData.length - 2) / 2 !== NOTE_DATA_BYTES) throw new Error(`noteData must be exactly ${NOTE_DATA_BYTES} bytes`);
}

/** Build a native-ETH shield (public deposit). ownerCommitment / noteSecret come from the wallet keys. */
export function buildShieldNative(vault: Address, ownerCommitment: bigint, noteSecret: bigint, amountWei: bigint, noteData: Hex): TxRequest {
  requireNoteData(noteData);
  return {
    to: vault,
    data: encodeFunctionData({ abi: nativeVaultAbi, functionName: "deposit", args: [ownerCommitment, noteSecret, noteData] }),
    value: amountWei,
  };
}

/** Build an ERC-20 shield (requires a prior approve to the vault). */
export function buildShieldERC20(vault: Address, amount: bigint, ownerCommitment: bigint, noteSecret: bigint, noteData: Hex): TxRequest {
  requireNoteData(noteData);
  return {
    to: vault,
    data: encodeFunctionData({ abi: erc20VaultAbi, functionName: "deposit", args: [amount, ownerCommitment, noteSecret, noteData] }),
  };
}

/**
 * Private transfer / withdrawal. NOT IMPLEMENTED in this shell: it requires a Groth16 proof generated
 * locally from circuits/transaction.circom (witness = reference/typescript/src/txInputs.ts) and
 * submitted over a private channel (L3). Wiring: pick UTXOs -> build witness -> prove in a Web
 * Worker -> submit. The secret never leaves the device.
 */
export function buildTransact(): never {
  throw new Error(
    "buildTransact: client-side proving is not part of the V1 shell. Build the witness with " +
      "reference/typescript txInputs.ts, prove locally (Web Worker) with circuits/build, then submit " +
      "via a private relay/mempool. The spending key and note secrets never leave the device."
  );
}
