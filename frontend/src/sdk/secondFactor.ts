// The second confirmation above the high-value-secondary threshold (whale spec §24; plan V2 §5, §13): a
// WebAuthn platform-authenticator assertion — Face ID, Touch ID, Windows Hello — with user verification
// required, registered once in Settings; the wallet password is the fallback. It gates the action and
// holds no key material: the platform verifies the user; this wallet only checks that the credential it
// registered answered. No server is involved: the challenge is random and discarded.
import { session as defaultSession, type WalletSession } from "../wallet/session";

const RP_NAME = "Privacy Wallet";
const b64url = (b: ArrayBuffer | Uint8Array): string => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const challenge = () => crypto.getRandomValues(new Uint8Array(32));

export const webauthnAvailable = (): boolean => typeof navigator !== "undefined" && !!(navigator as any).credentials?.create && typeof (globalThis as any).PublicKeyCredential !== "undefined";

/** Register a platform authenticator for this wallet; returns the credential id to keep in settings. */
export async function registerSecondFactor(o: { rpId?: string; userName?: string } = {}): Promise<string> {
  if (!webauthnAvailable()) throw new Error("no platform authenticator is available in this browser");
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const cred = (await (navigator as any).credentials.create({
    publicKey: {
      challenge: challenge(),
      rp: { name: RP_NAME, ...(o.rpId ? { id: o.rpId } : {}) },
      user: { id: userId, name: o.userName ?? "privacy-wallet", displayName: o.userName ?? "Privacy Wallet" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
      timeout: 60_000,
      attestation: "none",
    },
  })) as { rawId: ArrayBuffer } | null;
  if (!cred?.rawId) throw new Error("the authenticator did not register a credential");
  return b64url(cred.rawId);
}

/** Ask the registered authenticator to verify the user now; true only when that credential answered. */
export async function assertSecondFactor(credentialId: string, o: { rpId?: string } = {}): Promise<boolean> {
  if (!webauthnAvailable()) return false;
  try {
    const a = (await (navigator as any).credentials.get({
      publicKey: { challenge: challenge(), allowCredentials: [{ type: "public-key", id: fromB64url(credentialId) }], userVerification: "required", timeout: 60_000, ...(o.rpId ? { rpId: o.rpId } : {}) },
    })) as { rawId: ArrayBuffer } | null;
    return !!a?.rawId && b64url(a.rawId) === credentialId;
  } catch {
    return false;
  }
}

/** The fallback: the wallet password, checked against the keystore (nothing is revealed; the phrase is discarded at once). */
export async function verifyPassword(password: string, s: WalletSession = defaultSession): Promise<boolean> {
  const phrase = await s.revealPhrase(password);
  return phrase !== null;
}
