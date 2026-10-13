// The zkAPI browser SDK when its clone is absent (V6 Stage 2). The SDK is not an npm dependency: Vite aliases
// "@openanonymity/zkapi-browser-sdk" to the clone ZKAPI_SDK_DIR names (default: the clone beside this repository), or to
// this module when there is none — a fresh checkout, the CI runner. Same exports; importing does nothing, using any of
// them says Private AI is not part of this build. `zkapiBundled` (src/zkapi/sdk.ts) tells the screens which one they have.
export class ZkapiUnavailable extends Error {
  constructor() {
    super("Private AI is not included in this build: the zkAPI SDK clone was not present when it was built.");
    this.name = "ZkapiUnavailable";
  }
}

const unavailable = (): never => {
  throw new ZkapiUnavailable();
};

export function configureBrowserSdk(): void {
  unavailable();
}
export const CHAT_SPENDING_TIER_USD: readonly number[] = [];
// module interop and promise checks may probe a few keys; any real use of the client throws
const PROBES = new Set(["then", "__esModule", "toJSON", "constructor", "$$typeof"]);
export const zkapiClient: any = new Proxy({}, { get: (_target, key) => (typeof key === "symbol" || PROBES.has(key) ? undefined : unavailable()) });
export default zkapiClient;
