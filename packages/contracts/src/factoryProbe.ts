// The factories' own predictions against this app's (audit round 2, critic gap 1). The wallet funds escrows and shield
// receivers at CREATE2 addresses it computes from the configured factory and the creation code it bundles. Nothing tied
// those addresses to the chain: a factory of another escrow version, another chain's address, or no contract at all
// passed every check, and an escrow funded at such an address could never be deployed. So each factory is asked where it
// would put a fixed probe (an order and a receipt no wallet makes: their salt is a tag's hash), and its answer must be
// this app's own prediction. The deployment guard loads this module when it runs, before a money operation: the creation
// codes stay out of the first route.
import { concatHex, encodeAbiParameters, getCreate2Address, keccak256, stringToHex, zeroHash, type Address } from "viem";
import { ABI, BYTECODE } from "./abi";
import { notThatContract, type DeploymentReader } from "./deployments";
import { predictReceiver, type ReceiverParams } from "./shield";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ONE = "0x0000000000000000000000000000000000000001" as Address;
const PROBE_SALT = keccak256(stringToHex("privacy-wallet/v6/deployment-probe"));

/** SwapOrderTypes.OrderParams of the probe, field for field. */
export const PROBE_ORDER = {
  orderId: PROBE_SALT,
  assetType: 0,
  asset: ZERO,
  amount: 1n,
  orderSigner: ONE,
  executeDeadline: 1n,
  refundAfter: 1n,
  refundVault: ZERO,
  refundOwnerCommitment: 0n,
  refundNoteSecret: 0n,
  refundNoteDataHash: zeroHash,
  executorTip: 0n,
} as const;

/** ShieldReceiverTypes.ReceiverParams of the probe. */
export const PROBE_RECEIPT: ReceiverParams = {
  receiptId: PROBE_SALT,
  asset: ZERO,
  minAmount: 100n,
  shieldTip: 0n,
  ownerCommitment: 0n,
  noteSecret: 0n,
  noteDataHash: zeroHash,
  fallbackRecipient: ONE,
};

/** abi.encode(OrderParams): a static struct, 12 words. */
const ORDER_PARAMS = [
  { type: "bytes32" },
  { type: "uint8" },
  { type: "address" },
  { type: "uint256" },
  { type: "address" },
  { type: "uint64" },
  { type: "uint64" },
  { type: "address" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "bytes32" },
  { type: "uint256" },
] as const;

/** Where a SwapOrderFactory at `factory` puts the probe order's escrow, by this app's creation code. */
export function probeEscrowOf(factory: Address): Address {
  const o = PROBE_ORDER;
  const encoded = encodeAbiParameters(ORDER_PARAMS, [
    o.orderId,
    o.assetType,
    o.asset,
    o.amount,
    o.orderSigner,
    o.executeDeadline,
    o.refundAfter,
    o.refundVault,
    o.refundOwnerCommitment,
    o.refundNoteSecret,
    o.refundNoteDataHash,
    o.executorTip,
  ]);
  return getCreate2Address({ from: factory, salt: o.orderId, bytecodeHash: keccak256(concatHex([BYTECODE.swapOrderEscrow, encoded])) });
}

/** A factory's answer for a probe, or null when the chain says no such contract is there; a failed read throws. */
async function predicted(client: DeploymentReader, address: Address, abi: readonly unknown[], probe: unknown): Promise<Address | null> {
  return (await client.readContract({ address, abi, functionName: "predict", args: [probe] }).catch((e: unknown) => {
    if (notThatContract(e)) return null;
    throw e;
  })) as Address | null;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The problems of the configured factories: none when each puts its probe where this app would. */
export async function factoryProblems(client: DeploymentReader, f: { swapFactory?: Address; shieldFactory?: Address }): Promise<string[]> {
  const problems: string[] = [];
  if (f.swapFactory) {
    const theirs = await predicted(client, f.swapFactory, ABI.swapOrderFactory, PROBE_ORDER);
    if (!theirs) problems.push(`no swap order factory answers at ${f.swapFactory}`);
    else if (!same(theirs, probeEscrowOf(f.swapFactory)))
      problems.push(`the swap order factory at ${f.swapFactory} creates escrows other than this app's (another escrow version)`);
  }
  if (f.shieldFactory) {
    const theirs = await predicted(client, f.shieldFactory, ABI.shieldReceiverFactory, PROBE_RECEIPT);
    if (!theirs) problems.push(`no shield receiver factory answers at ${f.shieldFactory}`);
    else if (!same(theirs, predictReceiver(f.shieldFactory, PROBE_RECEIPT)))
      problems.push(`the shield receiver factory at ${f.shieldFactory} creates receivers other than this app's (another receiver version)`);
  }
  return problems;
}
