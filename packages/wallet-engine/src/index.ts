// The wallet engine (doc §15; spec v2.0 §8): the public wallet the user connects — EIP-6963 discovery, the injected
// provider, WalletConnect on request — under the names of §15. Every call goes to the user's own wallet, which shows it
// and asks; nothing here holds or touches the shielded keys, and nothing signs on its own.
import { connection, discover, type ConnectionState, type ConnectorInfo } from "./connection";
import { activeProvider } from "./injected";

export {
  INJECTED_ID,
  WALLETCONNECT_ID,
  connection,
  discover,
  shortAccount,
  type ConnectionState,
  type ConnectionStatus,
  type ConnectorInfo,
} from "./connection";
export { activeProvider, injectedProvider, setActiveProvider, type Eip1193Provider } from "./injected";
export { configureWalletConnect, walletConnectAvailable } from "./walletConnect";

/** Connects a wallet: the chosen connector (its id from detectWallet), else the first wallet of this browser. Never throws. */
export const connect = (id?: string): Promise<ConnectionState> => connection.connect(id);
/** Forgets the connected wallet (the wallet itself stays as it is). */
export const disconnect = (): void => connection.disconnect();
/** Asks the wallet to switch to the deployment's chain; false when it refused or none is connected. */
export const switchNetwork = (): Promise<boolean> => connection.switchNetwork();
/** The connected account, or null. */
export const getAddress = (): string | null => connection.get().account;

/** The wallets this browser offers (EIP-6963 announcements, the injected provider, WalletConnect when configured). */
export function detectWallet(): ConnectorInfo[] {
  discover();
  return connection.get().connectors;
}

function connected(): { account: string; request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } {
  const p = activeProvider();
  const account = connection.get().account;
  if (!p || !account) throw new Error("no wallet connected");
  return { account, request: (args) => p.request(args) };
}

const utf8Hex = (text: string): string => "0x" + [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Asks the connected wallet to sign a text message (EIP-191 personal_sign); the wallet shows the text. */
export async function signMessage(message: string): Promise<string> {
  const w = connected();
  return (await w.request({ method: "personal_sign", params: [utf8Hex(message), w.account] })) as string;
}

/** Asks the connected wallet to sign typed data (EIP-712, eth_signTypedData_v4); the wallet shows every field. */
export async function requestSignature(typedData: { domain: object; types: object; primaryType: string; message: object }): Promise<string> {
  const w = connected();
  const json = JSON.stringify(typedData, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  return (await w.request({ method: "eth_signTypedData_v4", params: [w.account, json] })) as string;
}
