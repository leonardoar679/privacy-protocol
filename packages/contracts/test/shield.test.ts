// The shield receiver's address (spec v2.0 §11.2) as forge's factory predicts it: the vector is written by
// contracts/test/periphery/ShieldReceiver.t.sol (test_ShieldVectorIsCurrent), from this build's creation code.
import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { predictReceiver, receiverParamsJson, receiverParamsOf, receiverParamsProblem, shieldMinAmount, type ReceiverParams } from "../src/shield";
import vector from "../../../contracts/test/periphery/vectors/shield.json";

const v = vector as Record<string, string>;
const params: ReceiverParams = {
  receiptId: v.receiptId as Hex,
  asset: v.asset as Address,
  minAmount: BigInt(v.minAmount),
  shieldTip: BigInt(v.shieldTip),
  ownerCommitment: BigInt(v.ownerCommitment),
  noteSecret: BigInt(v.noteSecret),
  noteDataHash: v.noteDataHash as Hex,
  fallbackRecipient: v.fallbackRecipient as Address,
};

describe("the shield receiver's address (spec v2.0 §11.2)", () => {
  it("is the address forge's factory predicts for the same parameters", () => {
    expect(predictReceiver(v.factory as Address, params)).toBe(getAddress(v.receiver));
  });
  it("changes with every parameter and with the factory", () => {
    const base = predictReceiver(v.factory as Address, params);
    const variants: Partial<ReceiverParams>[] = [
      { receiptId: ("0x" + "11".repeat(32)) as Hex },
      { asset: "0x00000000000000000000000000000000000000e5" },
      { minAmount: params.minAmount + 1n },
      { shieldTip: params.shieldTip + 1n },
      { ownerCommitment: params.ownerCommitment + 1n },
      { noteSecret: params.noteSecret + 1n },
      { noteDataHash: ("0x" + "22".repeat(32)) as Hex },
      { fallbackRecipient: "0x00000000000000000000000000000000000000fb" },
    ];
    for (const change of variants) expect(predictReceiver(v.factory as Address, { ...params, ...change })).not.toBe(base);
    expect(predictReceiver("0x00000000000000000000000000000000000000f3", params)).not.toBe(base);
  });
  it("survives the journal's string form", () => {
    expect(receiverParamsOf(receiverParamsJson(params))).toEqual(params);
  });
});

describe("the receiver's minimum and its constructor's rules", () => {
  it("minAmount is a hundred tips: the most the tip may be is 1 % of it", () => {
    expect(shieldMinAmount(2_000_000_000_000_000n)).toBe(200_000_000_000_000_000n);
    expect(shieldMinAmount(0n)).toBe(1n);
    expect(receiverParamsProblem({ ...params, minAmount: shieldMinAmount(params.shieldTip) })).toBeNull();
  });
  it("refuses what the constructor refuses", () => {
    expect(receiverParamsProblem(params)).toBeNull();
    expect(receiverParamsProblem({ ...params, minAmount: 0n })).toMatch(/zero/);
    expect(receiverParamsProblem({ ...params, shieldTip: params.minAmount / 100n + 1n })).toMatch(/1 %/);
    expect(receiverParamsProblem({ ...params, fallbackRecipient: "0x0000000000000000000000000000000000000000" })).toMatch(/fallback/);
    expect(receiverParamsProblem({ ...params, receiptId: "0x12" })).toMatch(/receiptId/);
  });
});
