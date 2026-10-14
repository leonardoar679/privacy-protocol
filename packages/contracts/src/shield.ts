// The shield receiver's parameters and address (spec v2.0 §11.2; contracts/src/periphery/shield/): a same-chain swap pays
// a one-time CREATE2 receiver that only ever deposits into the asset's canonical vault as the note the wallet committed.
// Its address is a pure function of the factory and the parameters — keccak256(0xff ‖ factory ‖ receiptId ‖
// keccak256(creationCode ‖ abi.encode(params)))[12:] — so the wallet names it before anything exists on chain and the
// relayer checks a job against it before spending gas. Pinned against forge by contracts/test/periphery/vectors/shield.json.
import { encodeAbiParameters, getCreate2Address, keccak256, concatHex, type Address, type Hex } from "viem";
import { BYTECODE } from "./abi";

/** ShieldReceiverTypes.ReceiverParams, field for field. */
export interface ReceiverParams {
  receiptId: Hex;
  /** address(0) for ETH */
  asset: Address;
  minAmount: bigint;
  shieldTip: bigint;
  ownerCommitment: bigint;
  noteSecret: bigint;
  noteDataHash: Hex;
  fallbackRecipient: Address;
}

/** The same with the integers as decimal strings: how the journal keeps it and the relayer receives it. */
export interface ReceiverParamsJson {
  receiptId: Hex;
  asset: Address;
  minAmount: string;
  shieldTip: string;
  ownerCommitment: string;
  noteSecret: string;
  noteDataHash: Hex;
  fallbackRecipient: Address;
}

export const RECEIVER_PARAMS_TUPLE =
  "(bytes32 receiptId, address asset, uint256 minAmount, uint256 shieldTip, uint256 ownerCommitment, uint256 noteSecret, bytes32 noteDataHash, address fallbackRecipient)";

const PARAMS_ABI = [
  {
    type: "tuple",
    components: [
      { name: "receiptId", type: "bytes32" },
      { name: "asset", type: "address" },
      { name: "minAmount", type: "uint256" },
      { name: "shieldTip", type: "uint256" },
      { name: "ownerCommitment", type: "uint256" },
      { name: "noteSecret", type: "uint256" },
      { name: "noteDataHash", type: "bytes32" },
      { name: "fallbackRecipient", type: "address" },
    ],
  },
] as const;

/** ShieldReceiverTypes.TIP_DIVISOR: a receiver refuses shieldTip > minAmount / 100. */
export const SHIELD_TIP_DIVISOR = 100n;

/**
 * The receiver's `minAmount`: the least delivery that pays the tip. It only has to make the tip worthless to claim — a
 * donation of at least `100 × tip` to the user's note to collect `tip` — so it is exactly that, the smallest the
 * receiver accepts. Any delivery of a quote that could be shielded at all (minimum output ≥ 100 × tip, the engine's
 * rule) pays the tip, a lower minimum the user accepted later included.
 */
export const shieldMinAmount = (shieldTip: bigint): bigint => (shieldTip > 0n ? shieldTip * SHIELD_TIP_DIVISOR : 1n);

export const receiverParamsJson = (p: ReceiverParams): ReceiverParamsJson => ({
  receiptId: p.receiptId,
  asset: p.asset,
  minAmount: p.minAmount.toString(),
  shieldTip: p.shieldTip.toString(),
  ownerCommitment: p.ownerCommitment.toString(),
  noteSecret: p.noteSecret.toString(),
  noteDataHash: p.noteDataHash,
  fallbackRecipient: p.fallbackRecipient,
});

export const receiverParamsOf = (j: ReceiverParamsJson): ReceiverParams => ({
  receiptId: j.receiptId,
  asset: j.asset,
  minAmount: BigInt(j.minAmount),
  shieldTip: BigInt(j.shieldTip),
  ownerCommitment: BigInt(j.ownerCommitment),
  noteSecret: BigInt(j.noteSecret),
  noteDataHash: j.noteDataHash,
  fallbackRecipient: j.fallbackRecipient,
});

/** abi.encode(params), as the receiver's constructor argument. */
export const encodeReceiverParams = (p: ReceiverParams): Hex => encodeAbiParameters(PARAMS_ABI, [p]);

/** ShieldReceiverFactory.initCodeHash(p). */
export const receiverInitCodeHash = (p: ReceiverParams, creationCode: Hex = BYTECODE.shieldReceiver): Hex =>
  keccak256(concatHex([creationCode, encodeReceiverParams(p)]));

/** ShieldReceiverFactory.predict(p): the receiver's address, deployed or not. */
export const predictReceiver = (factory: Address, p: ReceiverParams, creationCode: Hex = BYTECODE.shieldReceiver): Address =>
  getCreate2Address({ from: factory, salt: p.receiptId, bytecodeHash: receiverInitCodeHash(p, creationCode) });

/** What a receiver's constructor refuses, checked before an address is named or a job accepted. */
export function receiverParamsProblem(p: ReceiverParams): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(p.receiptId)) return "receiptId must be 32 bytes";
  if (!/^0x[0-9a-fA-F]{40}$/.test(p.asset) || !/^0x[0-9a-fA-F]{40}$/.test(p.fallbackRecipient)) return "asset and fallbackRecipient must be addresses";
  if (/^0x0{40}$/.test(p.fallbackRecipient)) return "the fallback recipient is zero";
  if (p.minAmount <= 0n) return "minAmount is zero";
  if (p.shieldTip > p.minAmount / SHIELD_TIP_DIVISOR) return "the tip is above 1 % of minAmount";
  if (!/^0x[0-9a-fA-F]{64}$/.test(p.noteDataHash)) return "noteDataHash must be 32 bytes";
  return null;
}
