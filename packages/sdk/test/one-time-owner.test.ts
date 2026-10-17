// One-time owner commitments (the audit round of 2026-10-16, c18/c29/c37). Every protect, every order's refund note and every
// same-chain receipt had been made out to the privacy address's owner commitment — an indexed Deposited topic and a public
// escrow or receiver immutable —, so anyone could link a private swap to the public account that protected the funds. Each
// now names its own (keys.ts deriveOwnerKey from its secret): the calldata a protect sends on every path, the notes an
// order commits, the facade's note. Nothing a deposit publishes carries the privacy address's owner commitment, the spend
// key or a note's owner key; and an order an older build committed is never funded.
import { beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { utf8ToBytes } from "@noble/hashes/utils";
import { ABI } from "@privacy-wallet/contracts";
import { deriveKeys, deriveOwnerKey } from "@privacy-wallet/protocol/keys";
import { ownerCommitmentOf } from "@privacy-wallet/protocol/note";
import { erc20VaultAbi, nativeVaultAbi } from "../src/privacyProtocol";
import { prepareShield, type PreparedShield } from "../src/privateTx";
import { deriveRefundNote, deriveShieldNote } from "../src/keys/swapKeys";
import { committedToPrivacyAddress, OrderOutdated } from "../src/swapFunding";
import { classify } from "../src/operations/errors/catalog";
import { noteStore } from "../src/wallet/notes";
import type { Deployment } from "../src/chain";

const seed = utf8ToBytes("one-time-owner-test-seed");
const keys = deriveKeys(seed);
const main = ownerCommitmentOf(keys.spendKey);
const own = (secret: bigint) => ownerCommitmentOf(deriveOwnerKey(keys.spendKey, secret));
const VAULT = getAddress("0x36ffa23fd38ae93e2b01aa5fa1570845ada89469");
const USDC = getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
const USDC_VAULT = getAddress("0x00000000000000000000000000000000000c0de1");
const ROUTER = getAddress("0x00000000000000000000000000000000000000a7");
const deployment = (router?: Address): Deployment => ({
  chainId: 1,
  core: getAddress("0x00000000000000000000000000000000000000c0"),
  ethVault: VAULT,
  rpcUrl: "http://x",
  rpcUrls: ["http://x"],
  fromBlock: 0n,
  erc20Vaults: [{ symbol: "USDC", token: USDC, vault: USDC_VAULT, decimals: 6 }],
  ...(router ? { protectRouter: router } : {}),
});
const hex32 = (v: bigint) => v.toString(16).padStart(64, "0");

/** The owner commitment and secret a protect's deposit calldata names, decoded on its path. */
function named(p: PreparedShield): { ownerCommitment: bigint; noteSecret: bigint } {
  const data = p.deposit.data as Hex;
  if (p.deployment.protectRouter) {
    const d = decodeFunctionData({ abi: ABI.protectRouter, data });
    const a = d.args as readonly unknown[];
    return d.functionName === "protectETH"
      ? { ownerCommitment: a[0] as bigint, noteSecret: a[1] as bigint }
      : { ownerCommitment: a[2] as bigint, noteSecret: a[3] as bigint };
  }
  const d = p.token ? decodeFunctionData({ abi: erc20VaultAbi, data }) : decodeFunctionData({ abi: nativeVaultAbi, data });
  const a = d.args as readonly unknown[];
  return p.token ? { ownerCommitment: a[1] as bigint, noteSecret: a[2] as bigint } : { ownerCommitment: a[0] as bigint, noteSecret: a[1] as bigint };
}

beforeEach(() => noteStore.clear());

describe("a protect names its own owner commitment on every path", () => {
  it.each([
    ["through the router, ETH", deployment(ROUTER), null, VAULT],
    ["through the router, a token", deployment(ROUTER), USDC, USDC_VAULT],
    ["into the vault, ETH", deployment(), null, VAULT],
    ["into the vault, a token", deployment(), USDC, USDC_VAULT],
  ] as const)("%s: one-time, derived from the note's secret, never the privacy address's; nothing secret in the calldata", (_, d, token, vault) => {
    const a = prepareShield({ masterSeed: seed, deployment: d, amount: 10n ** 18n, token, vault });
    const b = prepareShield({ masterSeed: seed, deployment: d, amount: 10n ** 18n, token, vault });
    for (const p of [a, b]) {
      const n = named(p);
      expect(n.ownerCommitment).toBe(p.note.ownerCommitment);
      expect(n.noteSecret).toBe(p.note.noteSecret);
      expect(n.ownerCommitment).toBe(own(p.note.noteSecret));
      expect(n.ownerCommitment).not.toBe(main);
      const data = p.deposit.data.toLowerCase();
      for (const secret of [main, keys.spendKey, deriveOwnerKey(keys.spendKey, p.note.noteSecret)]) expect(data.includes(hex32(secret))).toBe(false);
    }
    expect(a.note.ownerCommitment, "two protects, two owner commitments").not.toBe(b.note.ownerCommitment);
    expect(b.counter).toBe(a.counter + 1);
  });
});

describe("an order's notes name their own owner commitments", () => {
  it("the refund note and a receipt's note: each its counter's secret's, distinct, never the privacy address's", () => {
    const refund = deriveRefundNote(seed, 10),
      shield = deriveShieldNote(seed, 11),
      refund2 = deriveRefundNote(seed, 12);
    expect(refund.ownerCommitment).toBe(own(refund.noteSecret));
    expect(shield.ownerCommitment).toBe(own(shield.noteSecret));
    expect(new Set([refund.ownerCommitment, shield.ownerCommitment, refund2.ownerCommitment, main]).size).toBe(4);
  });
});

describe("an order an older build committed under the privacy address's owner commitment", () => {
  it("is recognised by its refund's owner commitment, and its stop says nothing moved", () => {
    expect(committedToPrivacyAddress({ params: { refundOwnerCommitment: main.toString() } }, seed)).toBe(true);
    expect(committedToPrivacyAddress({ params: { refundOwnerCommitment: deriveRefundNote(seed, 3).ownerCommitment.toString() } }, seed)).toBe(false);
    expect(committedToPrivacyAddress({ params: {} }, seed)).toBe(false);
    expect(committedToPrivacyAddress({ params: { refundOwnerCommitment: "0x01" } }, seed)).toBe(false);
    expect(classify(new OrderOutdated())).toMatchObject({ code: "order_outdated", fundsClass: "not-moved", actions: ["new-quote"] });
  });
});
