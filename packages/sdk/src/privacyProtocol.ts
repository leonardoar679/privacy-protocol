// Thin SDK over the immutable contracts (ABI frozen in docs/protocol-spec-v1.0.md §14). Deposits
// (public shields) and the private `transact` call are built here; the proof behind `transact` is
// generated locally in a Web Worker (apps/web/src/prover) — never by shipping a secret to a server.
import { type Address, type Hex, encodeFunctionData, parseAbi } from "viem";
import type { PublicInputs } from "@privacy-wallet/protocol/prover";

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

export const erc20Abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)", "function allowance(address owner, address spender) view returns (uint256)", "function balanceOf(address owner) view returns (uint256)"]);

/** The approval the ERC-20 vault's deposit pulls from (plan §36); exact amount, never unlimited. */
export function buildApprove(token: Address, vault: Address, amount: bigint): TxRequest {
  return { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [vault, amount] }) };
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
 * Private transfer / withdrawal: the calldata of `PrivacyCore.transact` for a proof produced LOCALLY
 * (apps/web/src/prover: Web Worker over the normative packages/protocol prover) — the spending key and the
 * note secrets never leave the device. `proof` is abi.encode(a, b, c); `publicInputs` are the 14
 * public signals in the struct's order; each noteData is the fixed-size output payload.
 */
export function buildTransact(core: Address, call: { proof: Hex; publicInputs: PublicInputs }, noteData: [Hex, Hex, Hex]): TxRequest {
  noteData.forEach(requireNoteData);
  if ((call.proof.length - 2) / 2 !== 256) throw new Error("proof must be abi.encode(a, b, c): 256 bytes");
  const pi = call.publicInputs;
  return {
    to: core,
    data: encodeFunctionData({
      abi: coreAbi,
      functionName: "transact",
      args: [call.proof, {
        root: pi.root, nullifier0: pi.nullifier0, nullifier1: pi.nullifier1, outputBody0: pi.outputBody0, outputBody1: pi.outputBody1, outputBody2: pi.outputBody2,
        mode: pi.mode, withdrawalVault: pi.withdrawalVault, withdrawalAmount: pi.withdrawalAmount, withdrawalRecipient: pi.withdrawalRecipient,
        noteData0Hash: pi.noteData0Hash, noteData1Hash: pi.noteData1Hash, noteData2Hash: pi.noteData2Hash, txDomain: pi.txDomain,
      }, noteData[0], noteData[1], noteData[2]],
    }),
  };
}
