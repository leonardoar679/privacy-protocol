// The relayer's one account sends one transaction at a time, and what became of a send is the node's answer (a V6
// follow-up of 2026-10-15). Three senders share the account: the submissions (`Relayer.submit`), the swap executor and
// the shield executor. Each read its nonce from the node's pending count while another send could be between that read
// and its broadcast, and the swap and shield ticks run on the same interval. Two sends read the same nonce, and the node
// refused the second, or, priced 10 % higher, let it replace the first in the mempool. The swap executor took that
// refusal for a failed execution (`execute-failed`) or a failed refund (`refund-failed`, final).
// Here a send waits until the one before it was broadcast or refused, then reads its nonce. It is signed before it is
// broadcast, so its hash is known when the broadcast answers with an error. A node that holds the transaction took it
// (viem retries a request whose answer was lost, and the node refuses the retry as "already known"); a node that does
// not know it refused it; and when the node cannot be read, the transaction is watched like any other until it is mined
// or dropped (DROP_AFTER_MS).
import { TransactionNotFoundError, keccak256, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { redactUrls } from "@privacy-wallet/server-kit/redact";

/** How long a transaction the node does not know is waited for after it was sent before it counts as dropped. */
export const DROP_AFTER_MS = 10 * 60_000;

/** A job's transaction in flight: the state it was sent from, when (unix seconds) and whether no tip pays for it. */
export interface SentTx<S extends string> {
  from: S;
  at: number;
  unpaid?: boolean;
}

/** A transaction the node took (or holds after all), by its hash; or one that never left, or that the node refused: nothing to wait for. */
export type SendResult = { ok: true; hash: Hex; note?: string } | { ok: false; error: string };
/** What a caller does with the signed transaction's hash before it is broadcast: its record (the fourth review round, 2026-11-03). */
export interface SendHooks {
  beforeBroadcast?: (hash: Hex) => void;
}

/** An error in one line: viem's summary, then the node's own words when it gave any, and no URL's path (a key lives there). */
export function reasonOf(e: unknown, n = 200): string {
  const x = e as { shortMessage?: string; details?: string; message?: string } | undefined;
  const summary = String(x?.shortMessage ?? x?.message ?? e)
    .split("\n")[0]
    .trim();
  const text = x?.shortMessage && x.details ? `${summary.replace(/\.$/, "")}: ${x.details}` : summary;
  return redactUrls(text.replace(/\s+/g, " ").trim()).slice(0, n);
}

/** The node answers that it does not know the transaction (never a failed read). */
export async function unknownToTheNode(publicClient: PublicClient, hash: Hex): Promise<boolean> {
  try {
    await publicClient.getTransaction({ hash });
    return false;
  } catch (e) {
    return e instanceof TransactionNotFoundError;
  }
}

export class Sender {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly account: PrivateKeyAccount,
    private readonly clients: { publicClient: PublicClient; walletClient: WalletClient },
  ) {}

  /** Sends once every earlier send of this account was broadcast or refused; never throws. */
  send(tx: { to: Address; data: Hex; gas: bigint }, hooks: SendHooks = {}): Promise<SendResult> {
    const run = this.queue.then(() => this.sendNow(tx, hooks));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async sendNow(tx: { to: Address; data: Hex; gas: bigint }, hooks: SendHooks): Promise<SendResult> {
    const { publicClient, walletClient } = this.clients;
    let signed: Hex;
    try {
      const request = await walletClient.prepareTransactionRequest({ account: this.account, chain: walletClient.chain, ...tx });
      signed = await walletClient.signTransaction(request as Parameters<WalletClient["signTransaction"]>[0]);
    } catch (e) {
      return { ok: false, error: reasonOf(e) }; // nothing left the relayer
    }
    const hash = keccak256(signed);
    // the caller's record first (the fourth review round, 2026-11-03): a crash between the broadcast and its record had left a
    // transaction this relayer did not know it sent — a fee note's only opening with it, or a re-send that reverted at its gas
    try {
      hooks.beforeBroadcast?.(hash);
    } catch (e) {
      return { ok: false, error: `not sent: its record failed (${reasonOf(e, 120)})` };
    }
    try {
      await walletClient.sendRawTransaction({ serializedTransaction: signed });
      return { ok: true, hash };
    } catch (e) {
      try {
        await publicClient.getTransaction({ hash });
        return { ok: true, hash }; // the node holds it
      } catch (read) {
        if (read instanceof TransactionNotFoundError) return { ok: false, error: reasonOf(e) };
        return { ok: true, hash, note: `the broadcast's answer was lost (${reasonOf(e, 120)}): watched until it is mined or dropped` };
      }
    }
  }
}
