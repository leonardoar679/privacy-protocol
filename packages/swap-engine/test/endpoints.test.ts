import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { encodeOrderParams, executionDigest, executionVouchDigest, initCodeHash, orderSignerAddress, orderVouchDigest, predictEscrow, shieldVouchDigest, signExecution, vouchedBy, word } from "../src/endpoints";
import type { OrderParams } from "../src/types";

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
// forge-emitted vector (SWAP_VECTOR=true forge test --match-test test_EmitEndpointVector)
const vec = read("../../../contracts/test/periphery/vectors/endpoint.json");
const escrowArtifact = read("../../../contracts/abi/periphery/SwapOrderEscrow.json");

const p: OrderParams = {
  orderId: vec.params.orderId, assetType: Number(vec.params.assetType) as 0 | 1, asset: vec.params.asset,
  amount: BigInt(vec.params.amount), orderSigner: vec.params.orderSigner,
  executeDeadline: Number(vec.params.executeDeadline), refundAfter: Number(vec.params.refundAfter),
  refundVault: vec.params.refundVault, refundOwnerCommitment: BigInt(vec.params.refundOwnerCommitment),
  refundNoteSecret: BigInt(vec.params.refundNoteSecret), refundNoteDataHash: vec.params.refundNoteDataHash,
  executorTip: BigInt(vec.params.executorTip),
};

describe("one-time EVM endpoint == SwapOrderFactory.predict (forge vector)", () => {
  it("abi.encode(OrderParams) is 12 words", () => {
    expect(encodeOrderParams(p).length).toBe(12 * 32);
  });
  it("initCodeHash matches", () => {
    expect(initCodeHash(escrowArtifact.bytecode, p).toLowerCase()).toBe(vec.initCodeHash.toLowerCase());
  });
  it("predicted escrow address matches", () => {
    expect(predictEscrow(vec.factory, escrowArtifact.bytecode, p).toLowerCase()).toBe(vec.predicted.toLowerCase());
  });
  it("a different orderId gives a different address", () => {
    const q = { ...p, orderId: ("0x" + "11".repeat(32)) as `0x${string}` };
    expect(predictEscrow(vec.factory, escrowArtifact.bytecode, q)).not.toBe(predictEscrow(vec.factory, escrowArtifact.bytecode, p));
  });
});

describe("execution authorization == SwapOrderEscrow.executionDigest (forge vector)", () => {
  it("digest matches for the vector's provider / value / calldata hash / deadline", () => {
    // the vector carries keccak256(calldata); rebuild the digest from the hash directly
    const { provider, value, calldataHash, deadline, digest } = vec.execution;
    const manual = (() => {
      const b = (h: string) => Buffer.from(h.replace(/^0x/, ""), "hex");
      const tag = keccak_256(new TextEncoder().encode("privacy-protocol/v1.1/swap-order/execute"));
      return "0x" + Buffer.from(keccak_256(Buffer.concat([
        Buffer.from(tag), word(BigInt(vec.chainId)), word(BigInt(vec.predicted)), b(vec.params.orderId), word(BigInt(provider)), word(BigInt(value)), b(calldataHash), word(BigInt(deadline)),
      ]))).toString("hex");
    })();
    expect(manual.toLowerCase()).toBe(digest.toLowerCase());
  });
  it("executionDigest() over the calldata itself agrees with the hash-based form", () => {
    const cd = "0x1234";
    const h = "0x" + Buffer.from(keccak_256(Buffer.from("1234", "hex"))).toString("hex");
    const viaFn = executionDigest(1n, vec.predicted, vec.params.orderId, vec.execution.provider, 5n, cd, 99);
    const tag = keccak_256(new TextEncoder().encode("privacy-protocol/v1.1/swap-order/execute"));
    const manual = "0x" + Buffer.from(keccak_256(Buffer.concat([
      Buffer.from(tag), word(1n), word(BigInt(vec.predicted)), Buffer.from(vec.params.orderId.slice(2), "hex"), word(BigInt(vec.execution.provider)), word(5n), Buffer.from(h.slice(2), "hex"), word(99),
    ]))).toString("hex");
    expect(viaFn).toBe(manual);
  });
  it("signExecution produces a low-s r‖s‖v signature that recovers to the order signer", () => {
    const key = Buffer.from("a11ce0".padStart(64, "0"), "hex"); // 0xA11CE0, the key the forge test uses
    expect(orderSignerAddress(key).toLowerCase()).toBe(vec.params.orderSigner.toLowerCase());
    const sig = signExecution(key, vec.execution.digest);
    expect(sig.length).toBe(2 + 130);
    const r = BigInt("0x" + sig.slice(2, 66)), s = BigInt("0x" + sig.slice(66, 130)), v = Number("0x" + sig.slice(130));
    expect(s <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n).toBe(true);
    const recovered = secp256k1.Signature.fromCompact(sig.slice(2, 130)).addRecoveryBit(v - 27).recoverPublicKey(Buffer.from(vec.execution.digest.slice(2), "hex"));
    const addr = "0x" + Buffer.from(keccak_256(recovered.toRawBytes(false).subarray(1)).subarray(12)).toString("hex");
    expect(addr.toLowerCase()).toBe(vec.params.orderSigner.toLowerCase());
    void r;
  });
});

describe("execution signatures (wallet-side signing, service-side recovery)", () => {
  it("recovers the one-time signer and rejects a tampered signature", async () => {
    const { recoverExecutionSigner, signExecution, orderSignerAddress, executionDigest } = await import("../src/endpoints");
    const key = new Uint8Array(32).fill(7);
    const digest = executionDigest(1n, "0x" + "11".repeat(20), "0x" + "22".repeat(32), "0x" + "33".repeat(20), 10n ** 18n, "0x1234", 1_900_000_000);
    const sig = signExecution(key, digest);
    expect(recoverExecutionSigner(digest, sig).toLowerCase()).toBe(orderSignerAddress(key).toLowerCase());
    const tampered = (sig.slice(0, 10) + (sig[10] === "0" ? "1" : "0") + sig.slice(11)) as `0x${string}`;
    expect(recoverExecutionSigner(digest, tampered).toLowerCase()).not.toBe(orderSignerAddress(key).toLowerCase());
    expect(() => recoverExecutionSigner(digest, (sig.slice(0, -2) + "1d") as `0x${string}`)).toThrow(/bad v/);
  });
});

describe("the API's vouches (a V6 follow-up of 2026-10-16)", () => {
  const key = new Uint8Array(32).fill(0x5a);
  const voucher = orderSignerAddress(key);
  const escrow = "0x00000000000000000000000000000000000e5c00";
  const provider = "0x00000000000000000000000000000000000000a1";
  const calldata = "0x1234";
  it("each digest is its own: an order's, a call's and an execution's never coincide, and their bytes are pinned", () => {
    const order = orderVouchDigest(1n, escrow);
    const call = executionVouchDigest(1n, escrow, provider, 5n, calldata, 1801);
    const execution = executionDigest(1n, escrow, "0x" + "00".repeat(32), provider, 5n, calldata, 1801);
    const receipt = shieldVouchDigest(1n, escrow);
    expect(new Set([order, call, execution, receipt]).size, "a receipt's digest is apart from an order's at the same address").toBe(4);
    expect(orderVouchDigest(2n, escrow), "the chain is in it").not.toBe(order);
    expect(executionVouchDigest(1n, escrow, provider, 5n, "0x1235", 1801), "the calldata is in it").not.toBe(call);
    // the API and every relayer must agree byte for byte, whatever version each runs (abi.encode, recomputed with viem)
    expect([order, call]).toEqual([
      "0xc6668c4a6ed881c69b81de98a5a143f669818322cd508fec047da1d316fd840e",
      "0x9c316836b195e491f3dee9a05058179c60215b9d6bf4c5b878e6a93191af490d",
    ]);
  });
  it("a vouch is the voucher's over its own digest only: another key's, another digest's, a malformed or missing one are not", () => {
    const order = orderVouchDigest(1n, escrow);
    const call = executionVouchDigest(1n, escrow, provider, 5n, calldata, 1801);
    const vouch = signExecution(key, order);
    expect(vouchedBy(voucher, order, vouch)).toBe(true);
    expect(vouchedBy(voucher.toUpperCase().replace("0X", "0x"), order, vouch), "the address in any case").toBe(true);
    expect(vouchedBy(voucher, call, vouch), "an order's vouch is no call's").toBe(false);
    expect(vouchedBy(voucher, order, signExecution(new Uint8Array(32).fill(0x5b), order)), "another key").toBe(false);
    for (const bad of [undefined, null, "", "0x12", vouch.slice(0, -2), 42]) expect(vouchedBy(voucher, order, bad)).toBe(false);
    // while the key rotates, any of the listed addresses (2026-10-16); none listed, no one's
    const next = orderSignerAddress(new Uint8Array(32).fill(0x5c));
    expect(vouchedBy([next, voucher], order, vouch), "the former key, still listed").toBe(true);
    expect(vouchedBy([next], order, vouch), "the former key, dropped").toBe(false);
    expect(vouchedBy([], order, vouch)).toBe(false);
  });
});
