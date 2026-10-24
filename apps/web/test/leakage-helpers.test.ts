// The leakage gate's own reading (audit round 2, n80): a secret is found in any case and in base64, not only as lowercase hex,
// and the secret set holds a deposited note's own owner key and every journaled order's one-time key.
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { deriveKeys, deriveNoteSecret, deriveOwnerKey } from "@privacy-wallet/protocol/keys";
import { ownerCommitmentOf } from "@privacy-wallet/protocol/note";
import { deriveOrderKey } from "@privacy-wallet/sdk/keys/swapKeys";
import { session } from "@privacy-wallet/sdk/wallet/session";
import type { StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import { forms, leaks, sessionSecrets } from "./helpers/leakage";

afterEach(() => session.forget());

describe("the leakage helpers", () => {
  it("find a secret in uppercase hex and in base64", () => {
    const secret = 0x1234567890abcdef1234567890abcdefn;
    const set = [{ name: "a secret", values: forms(secret) }];
    expect(leaks(`{"k":"0x${secret.toString(16).toUpperCase()}"}`, set)).toEqual([expect.stringContaining("a secret")]);
    const b64 = Buffer.from(secret.toString(16).padStart(64, "0"), "hex").toString("base64");
    expect(leaks(`token=${b64}`, set), "base64").toEqual([expect.stringContaining("a secret")]);
    expect(leaks(`token=${b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`, set), "base64url").toEqual([expect.stringContaining("a secret")]);
    expect(leaks("nothing here", set)).toEqual([]);
  });

  it("hold a deposited note's owner key and every order's one-time key", async () => {
    await session.create("pw");
    session.acknowledgePhrase();
    const seed = session.state().seed!;
    const keys = deriveKeys(seed);
    const secret = deriveNoteSecret(keys.noteKey, 3);
    const ownerKey = deriveOwnerKey(keys.spendKey, secret);
    const orderId = ("0x" + "0a".repeat(32)) as `0x${string}`;
    session.update((j) => {
      j.notes = [
        {
          note: { vaultId: "1", amount: "5", ownerCommitment: ownerCommitmentOf(ownerKey).toString(), noteSecret: secret.toString() },
          leafIndex: 4,
          noteData: "0x",
          spent: false,
          label: "shield",
        } as never,
      ];
      j.swaps = [{ orderId } as unknown as StoredSwap];
    });
    const { secrets } = sessionSecrets({ password: "pw" });
    const owner = secrets.find((s) => /owner key of the note at leaf 4/.test(s.name));
    expect(owner?.values).toContain(ownerKey.toString(16));
    const order = secrets.find((s) => /one-time key of order/.test(s.name));
    expect(order?.values).toContain(BigInt(deriveOrderKey(seed, orderId).privateKey).toString(16));
  });
});
