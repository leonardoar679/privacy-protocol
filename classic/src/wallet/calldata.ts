// The transactions the Classic app builds for a wallet to sign (spec v3.0 §7.5–§7.6): a deposit through the router
// (`deposit(instance, commitment, encryptedNote)` with the denomination as value; the direct `pool.deposit(commitment)`
// behind a warning), a wallet-mode withdrawal straight to the pool (`withdraw(proof, root, nullifierHash, recipient,
// relayer, fee, refund)`) or through the router, and the six arguments a relayer's request carries. ABI by hand, held to
// real mainnet transactions by the tests. Pure.
export type Hex = `0x${string}`;

const keccakSelectors = {
  routerDeposit: "0x13d98d13", // deposit(address,bytes32,bytes)
  routerWithdraw: "0xb438689f", // withdraw(address,bytes,bytes32,bytes32,address,address,uint256,uint256)
  poolDeposit: "0xb214faa5", // deposit(bytes32)
  poolWithdraw: "0x21a0adb6", // withdraw(bytes,bytes32,bytes32,address,address,uint256,uint256)
} as const;
export const SELECTORS = Object.freeze(keccakSelectors);

const word = (x: bigint | number): string => {
  const v = BigInt(x);
  if (v < 0n || v >= 2n ** 256n) throw new Error("a word is 256 bits");
  return v.toString(16).padStart(64, "0");
};
const bytes32 = (h: string): string => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error("a bytes32 is 0x and 64 hex digits");
  return h.slice(2).toLowerCase();
};
const addressWord = (a: string): string => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error("an address is 0x and 40 hex digits");
  return a.slice(2).toLowerCase().padStart(64, "0");
};
const bytesTail = (h: string): string => {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(h)) throw new Error("bytes are 0x and whole hex bytes");
  const data = h.slice(2).toLowerCase();
  return word(data.length / 2) + data.padEnd(Math.ceil(data.length / 64) * 64, "0");
};

export interface WithdrawArgs {
  /** 0x and 512 hex digits */
  proof: Hex;
  root: Hex;
  nullifierHash: Hex;
  recipient: Hex;
  /** the relayer's reward account; the zero address or the recipient in wallet mode */
  relayer: Hex;
  feeWei: bigint;
  refundWei: bigint;
}

/** router.deposit(instance, commitment, encryptedNote): the app sends no encrypted note (the original's backup-on-chain is not copied). */
export function encodeRouterDeposit(instance: Hex, commitment: Hex, encryptedNote: Hex = "0x"): Hex {
  return `${SELECTORS.routerDeposit}${addressWord(instance)}${bytes32(commitment)}${word(0x60)}${bytesTail(encryptedNote)}` as Hex;
}

export function encodePoolDeposit(commitment: Hex): Hex {
  return `${SELECTORS.poolDeposit}${bytes32(commitment)}` as Hex;
}

const withdrawStatics = (a: WithdrawArgs): string =>
  bytes32(a.root) + bytes32(a.nullifierHash) + addressWord(a.recipient) + addressWord(a.relayer) + word(a.feeWei) + word(a.refundWei);
const proofTail = (proof: Hex): string => {
  if (!/^0x[0-9a-fA-F]{512}$/.test(proof)) throw new Error("a proof is 0x and 512 hex digits");
  return bytesTail(proof);
};

/** pool.withdraw(proof, root, nullifierHash, recipient, relayer, fee, refund): the bytes offset after the seven head words. */
export function encodePoolWithdraw(a: WithdrawArgs): Hex {
  return `${SELECTORS.poolWithdraw}${word(7 * 32)}${withdrawStatics(a)}${proofTail(a.proof)}` as Hex;
}

/** router.withdraw(instance, proof, root, nullifierHash, recipient, relayer, fee, refund): eight head words. */
export function encodeRouterWithdraw(instance: Hex, a: WithdrawArgs): Hex {
  return `${SELECTORS.routerWithdraw}${addressWord(instance)}${word(8 * 32)}${withdrawStatics(a)}${proofTail(a.proof)}` as Hex;
}

/** The arguments of a pool withdrawal's call data (the tests hold the encoder to real transactions). */
export function decodePoolWithdraw(data: Hex): WithdrawArgs {
  if (!data.startsWith(SELECTORS.poolWithdraw)) throw new Error("not pool.withdraw");
  const d = data.slice(10);
  const w = (i: number) => d.slice(64 * i, 64 * (i + 1));
  const offset = Number(BigInt("0x" + w(0))) * 2;
  const length = Number(BigInt("0x" + d.slice(offset, offset + 64)));
  return {
    proof: `0x${d.slice(offset + 64, offset + 64 + length * 2)}`,
    root: `0x${w(1)}`,
    nullifierHash: `0x${w(2)}`,
    recipient: `0x${w(3).slice(24)}`,
    relayer: `0x${w(4).slice(24)}`,
    feeWei: BigInt("0x" + w(5)),
    refundWei: BigInt("0x" + w(6)),
  };
}

export function decodeRouterDeposit(data: Hex): { instance: Hex; commitment: Hex; encryptedNote: Hex } {
  if (!data.startsWith(SELECTORS.routerDeposit)) throw new Error("not router.deposit");
  const d = data.slice(10);
  const w = (i: number) => d.slice(64 * i, 64 * (i + 1));
  const offset = Number(BigInt("0x" + w(2))) * 2;
  const length = Number(BigInt("0x" + d.slice(offset, offset + 64)));
  return { instance: `0x${w(0).slice(24)}`, commitment: `0x${w(1)}`, encryptedNote: `0x${d.slice(offset + 64, offset + 64 + length * 2)}` };
}

/** The six arguments of a relayer request, as its validator wants them: bytes32 strings for the numbers too. */
export function relayerArgs(a: Omit<WithdrawArgs, "proof">): [Hex, Hex, Hex, Hex, Hex, Hex] {
  return [
    `0x${bytes32(a.root)}`,
    `0x${bytes32(a.nullifierHash)}`,
    `0x${addressWord(a.recipient).slice(24)}`,
    `0x${addressWord(a.relayer).slice(24)}`,
    `0x${word(a.feeWei)}`,
    `0x${word(a.refundWei)}`,
  ];
}
