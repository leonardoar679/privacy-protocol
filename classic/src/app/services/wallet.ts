// The wallet session (spec v3.0 §7.5–§7.6; V7 Stage 9): the wallets this page can see, one connected account on
// mainnet (or "wrong network"), its changes followed, and a transaction handed to it — a deposit through the router (or
// straight to the pool when the router has disabled it, the user's explicit choice) or a wallet-mode withdrawal straight
// to the pool. The receipt is read from the app's endpoints by the flow. Pure over the injected pieces.
import type { Rpc } from "../../history/sync";
import type { ConnectionState } from "../../model/types";
import type { Pool } from "../../model/pools";
import { encodePoolDeposit, encodePoolWithdraw, encodeRouterDeposit, type WithdrawArgs } from "../../wallet/calldata";
import { connect, reconnect, sendTransaction, stateOf, watch, MAINNET_CHAIN_ID } from "../../wallet/connection";
import { discoverWallets, type DiscoveredWallet, type Eip1193Provider } from "../../wallet/injected";

export interface WalletSessionDeps {
  discover?: () => Promise<DiscoveredWallet[]>;
  expectedChainId?: number;
  /** the router's address: deposits go through it */
  router: `0x${string}`;
  onChange?: (state: ConnectionState) => void;
}

export class WalletSession {
  state: ConnectionState = { status: "disconnected" };
  wallets: DiscoveredWallet[] = [];
  walletId: string | null = null;
  private provider: Eip1193Provider | null = null;
  private unwatch: (() => void) | null = null;

  constructor(private readonly d: WalletSessionDeps) {}

  private set(state: ConnectionState): ConnectionState {
    this.state = state;
    this.d.onChange?.(state);
    return state;
  }

  async discover(): Promise<DiscoveredWallet[]> {
    this.wallets = await (this.d.discover ?? discoverWallets)();
    return this.wallets;
  }

  private follow(provider: Eip1193Provider): void {
    this.unwatch?.();
    let accounts: `0x${string}`[] = this.state.status === "disconnected" ? [] : [this.state.account as `0x${string}`];
    let chainId = this.state.status === "disconnected" ? 0 : this.state.chainId;
    this.unwatch = watch(provider, (change) => {
      if (change.accounts) accounts = change.accounts;
      if (change.chainId !== undefined) chainId = change.chainId;
      this.set(stateOf(accounts, chainId, this.d.expectedChainId ?? MAINNET_CHAIN_ID));
    });
  }

  /** Asks the wallet (the user's prompt) and follows it. */
  async connect(walletId: string): Promise<ConnectionState> {
    const wallet = this.wallets.find((w) => w.info.id === walletId);
    if (!wallet) throw new Error("no such wallet on this page");
    const state = await connect(wallet.provider, this.d.expectedChainId ?? MAINNET_CHAIN_ID);
    this.provider = wallet.provider;
    this.walletId = walletId;
    this.set(state);
    this.follow(wallet.provider);
    return state;
  }

  /** The accounts already granted, without a prompt. */
  async reconnect(walletId: string): Promise<ConnectionState> {
    const wallet = this.wallets.find((w) => w.info.id === walletId);
    if (!wallet) return this.state;
    const state = await reconnect(wallet.provider, this.d.expectedChainId ?? MAINNET_CHAIN_ID);
    if (state.status === "disconnected") return state;
    this.provider = wallet.provider;
    this.walletId = walletId;
    this.set(state);
    this.follow(wallet.provider);
    return state;
  }

  disconnect(): void {
    this.unwatch?.();
    this.unwatch = null;
    this.provider = null;
    this.walletId = null;
    this.set({ status: "disconnected" });
  }

  /**
   * The connected wallet's provider as a JSON-RPC function, for the receipts of the user's own transactions (the tenth review round,
   * C10-12): its node sent them and knows them; the app's endpoint asked for them had learned which IP made a deposit. Null with no wallet.
   */
  receiptRpc(): Rpc | null {
    const provider = this.provider;
    if (!provider) return null;
    return (method, params) => provider.request({ method, params });
  }

  get account(): `0x${string}` | null {
    return this.state.status === "connected" ? (this.state.account as `0x${string}`) : null;
  }

  private connected(): { provider: Eip1193Provider; from: `0x${string}` } {
    if (!this.provider || this.state.status !== "connected") throw new Error("no wallet is connected on Ethereum");
    return { provider: this.provider, from: this.state.account as `0x${string}` };
  }

  /** The deposit: through the router by default; straight to the pool only when asked (the router disabled the instance). */
  async sendDeposit(pool: Pool, commitment: `0x${string}`, { direct = false }: { direct?: boolean } = {}): Promise<`0x${string}`> {
    const { provider, from } = this.connected();
    const to = direct ? pool.address : this.d.router;
    const data = direct ? encodePoolDeposit(commitment) : encodeRouterDeposit(pool.address, commitment);
    return sendTransaction(provider, { from, to, data, valueWei: pool.denominationWei }, this.d.expectedChainId ?? MAINNET_CHAIN_ID);
  }

  /** The wallet-mode withdrawal, straight to the pool: no relayer, no fee, no refund. */
  async sendWithdrawal(pool: Pool, args: WithdrawArgs): Promise<`0x${string}`> {
    const { provider, from } = this.connected();
    return sendTransaction(provider, { from, to: pool.address, data: encodePoolWithdraw(args), valueWei: 0n }, this.d.expectedChainId ?? MAINNET_CHAIN_ID);
  }
}
