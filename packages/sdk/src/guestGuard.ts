// Walletless mode (plan §49): a guest sends coins from any wallet to a deposit address with a memo, both
// handed out by the swap service. Before the instruction is shown, this browser checks it itself, the way
// the wallet checks a provider call (providerCall.ts): the address must be THORChain's inbound vault for
// that chain as a quorum of public THORNode gateways reports it, or another of its active vaults that every
// gateway that answers lists (THORChain moves its inbound vault between them; the same requests for every
// user), and the memo must swap into the asset the guest chose, pay the destination the guest typed,
// fit the chain's 80-byte OP_RETURN, and enforce a minimum no lower than the quote the guest saw. The
// memo carries no refund address: THORChain refunds the sender, which here is the guest's own wallet.
import { from1e8, MinimumMoved, ProviderCallMismatch, THOR_CHAIN, thorAsset, thorAssetShort, thornodeActiveVault, thornodeInbound, type ActiveVaultLookup, type InboundLookup } from "./providerCall";
import type { AssetRef } from "./swapService";

/** A guest signs nothing here: the instruction is simply not shown. */
export class GuestInstructionMismatch extends ProviderCallMismatch {
  constructor(field: string, detail: string) {
    super("thorchain", field, detail);
    this.message = `the deposit instruction does not match what you asked for (${field}: ${detail}) — not showing it`;
  }
}

export interface GuestInstruction { provider: string; ingress: { to: string; memo?: string; amount: string; expiresAt: number } }
export interface CheckedGuest { depositAddress: string; memo: string; minOut: bigint; gateways: number }

/** UTXO chains THORChain serves for guests; their memo rides in OP_RETURN (80 bytes). */
const UTXO = ["BTC", "LTC", "DOGE", "BCH"];
const UTXO_MEMO_BYTES = 80;

export async function checkGuestInstruction(ins: GuestInstruction, e: {
  from: AssetRef; to: AssetRef; destination: string; amount: bigint;
  /** the minimum the guest saw in the quote; a lower one throws MinimumMoved (shown, then accepted or not) */
  approvedMin: bigint; inbound?: InboundLookup; active?: ActiveVaultLookup; now?: number;
}): Promise<CheckedGuest> {
  const fail = (field: string, detail: string): never => { throw new GuestInstructionMismatch(field, detail); };
  const now = e.now ?? Math.floor(Date.now() / 1000);
  if (ins.provider !== "thorchain") fail("provider", `${ins.provider} deposit addresses are not verifiable here`);
  const chain = THOR_CHAIN[e.from.chain];
  if (!chain || !UTXO.includes(chain)) fail("source", `guests sell ${UTXO.join(" / ")} here, not ${e.from.chain}`);
  if (BigInt(ins.ingress.amount) !== e.amount) fail("amount", `the instruction is for ${ins.ingress.amount}, not ${e.amount}`);
  if (ins.ingress.expiresAt <= now) fail("expiry", "the instruction has already expired");
  const v = await (e.inbound ?? ((c: string) => thornodeInbound(c)))(chain);
  if (v.halted) fail("inbound", `THORChain has halted ${chain} inbound`);
  // the refusal never repeats the address the service named: a guest must have nothing to copy
  let gateways = v.agreeing.length;
  if (!v.address || ins.ingress.to.toLowerCase() !== v.address.toLowerCase()) {
    try {
      gateways = (await (e.active ?? ((c: string, x: string) => thornodeActiveVault(c, x)))(chain, ins.ingress.to)).confirmedBy.length;
    } catch (err) {
      if (err instanceof ProviderCallMismatch) fail("vault", `the address it names is not a ${chain} vault the THORNode gateways list`);
      throw err;
    }
  }
  const memo = ins.ingress.memo ?? "";
  if (new TextEncoder().encode(memo).length > UTXO_MEMO_BYTES) fail("memo", `${memo.length} bytes do not fit a ${chain} OP_RETURN (80)`);
  const m = /^=:([^:]+):([^:/]+):(\d+)$/.exec(memo);
  if (!m) fail("memo", `"${memo}" is not =:ASSET:DEST:LIMIT`);
  const [, asset, dest, limit] = m!;
  if (asset !== thorAsset(e.to) && asset !== thorAssetShort(e.to)) fail("memo asset", `${asset} is not ${thorAsset(e.to)}`);
  const evmDest = /^0x[0-9a-fA-F]{40}$/.test(e.destination);
  if (evmDest ? dest.toLowerCase() !== e.destination.toLowerCase() : dest !== e.destination) fail("receiver", "the memo pays another address than the one you typed");
  const minOut = from1e8(BigInt(limit), e.to.decimals);
  if (minOut < e.approvedMin) throw new MinimumMoved(minOut, e.approvedMin);
  return { depositAddress: ins.ingress.to, memo, minOut, gateways };
}
