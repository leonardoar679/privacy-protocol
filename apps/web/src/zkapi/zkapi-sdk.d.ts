/** true when the build carries the zkAPI SDK clone (vite.config.ts zkapiSdk), false with the stub (src/zkapi/unavailable.ts) */
declare const __ZKAPI__: boolean;

// Ambient types for the zkAPI browser SDK (plain ESM, no bundled types). Only the host-facing
// surface this wallet uses is declared; everything else is `any` on purpose.
declare module "@openanonymity/zkapi-browser-sdk" {
  export type ZkapiTransport = (url: string, init: RequestInit, hints: { preferProxy?: boolean }) => Promise<Response>;
  export function configureBrowserSdk(options: {
    configUrl: string;
    workerUrl: string;
    transport?: ZkapiTransport | null;
    mode?: "browser";
    requestTestnetPassword?: ((args: { authenticate: (value: string, o?: { signal?: AbortSignal }) => Promise<void>; signal?: AbortSignal }) => Promise<void>) | null;
  }): void;
  export const CHAT_SPENDING_TIER_USD: readonly number[];
  export const zkapiClient: any;
}
declare module "@openanonymity/zkapi-browser-sdk/client" {
  const client: any;
  export default client;
}
declare module "@openanonymity/zkapi-browser-sdk/build" {
  export function buildBrowserSdkAssets(o: { outDir: string; network?: "sepolia" | "mainnet"; publicPath?: string; build: unknown }): Promise<unknown>;
  export function verifyBrowserSdkAssets(): Promise<unknown>;
}
