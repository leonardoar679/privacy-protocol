// The factories' own predictions (audit round 2, critic gap 1): each configured factory is asked where it would put a fixed
// probe, and its answer must be this app's CREATE2 prediction from the creation code it bundles. The honest answers here
// are computed independently of the module, from forge's exported artifacts; another version's answer, no contract at the
// address and a failed read are told apart.
import { describe, expect, it } from "vitest";
import {
  concatHex,
  ContractFunctionExecutionError,
  ContractFunctionZeroDataError,
  encodeAbiParameters,
  getCreate2Address,
  HttpRequestError,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import escrowJson from "../../../contracts/abi/periphery/SwapOrderEscrow.json";
import receiverJson from "../../../contracts/abi/periphery/ShieldReceiver.json";
import type { DeploymentReader } from "../src";
import { factoryProblems, PROBE_ORDER, PROBE_RECEIPT } from "../src/factoryProbe";

const SWAP = "0x00000000000000000000000000000000000000f2" as const;
const SHIELD = "0x00000000000000000000000000000000000000f5" as const;
const OTHER = "0x00000000000000000000000000000000000000e5";

const o = PROBE_ORDER;
const escrowAt = (factory: Address): Address =>
  getCreate2Address({
    from: factory,
    salt: o.orderId,
    bytecodeHash: keccak256(
      concatHex([
        escrowJson.bytecode as Hex,
        encodeAbiParameters(parseAbiParameters("bytes32, uint8, address, uint256, address, uint64, uint64, address, uint256, uint256, bytes32, uint256"), [
          o.orderId,
          o.assetType,
          o.asset,
          o.amount,
          o.orderSigner,
          o.executeDeadline,
          o.refundAfter,
          o.refundVault,
          o.refundOwnerCommitment,
          o.refundNoteSecret,
          o.refundNoteDataHash,
          o.executorTip,
        ]),
      ]),
    ),
  });
const r = PROBE_RECEIPT;
const receiverAt = (factory: Address): Address =>
  getCreate2Address({
    from: factory,
    salt: r.receiptId,
    bytecodeHash: keccak256(
      concatHex([
        receiverJson.bytecode as Hex,
        encodeAbiParameters(parseAbiParameters("bytes32, address, uint256, uint256, uint256, uint256, bytes32, address"), [
          r.receiptId,
          r.asset,
          r.minAmount,
          r.shieldTip,
          r.ownerCommitment,
          r.noteSecret,
          r.noteDataHash,
          r.fallbackRecipient,
        ]),
      ]),
    ),
  });

/** A chain whose factories answer predict honestly, unless told: another address, null (no contract) or an error. */
function chain(o: { swap?: string | null | Error; shield?: string | null | Error } = {}): DeploymentReader & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    getChainId: async () => 1,
    readContract: async ({ address, functionName }) => {
      if (functionName !== "predict") throw new Error(`unexpected read ${address}.${functionName}`);
      asked.push(address.toLowerCase());
      const told = address.toLowerCase() === SWAP ? o.swap : address.toLowerCase() === SHIELD ? o.shield : undefined;
      const answer = told === undefined ? (address.toLowerCase() === SWAP ? escrowAt(SWAP) : receiverAt(SHIELD)) : told;
      if (answer instanceof Error) throw answer;
      if (answer === null)
        throw new ContractFunctionExecutionError(new ContractFunctionZeroDataError({ functionName: "predict" }), { abi: [], functionName: "predict" });
      return answer;
    },
  };
}

describe("the factories' own predictions (audit round 2, critic gap 1)", () => {
  it("factories of this app's escrow and receiver code put the probes where this app predicts: no problem", async () => {
    const c = chain();
    expect(await factoryProblems(c, { swapFactory: SWAP, shieldFactory: SHIELD })).toEqual([]);
    expect(c.asked).toEqual([SWAP, SHIELD]);
  });

  it("a factory of another version, or no contract at the address, is named", async () => {
    expect(await factoryProblems(chain({ swap: OTHER }), { swapFactory: SWAP })).toEqual([expect.stringMatching(/creates escrows other than this app's/)]);
    expect(await factoryProblems(chain({ swap: null }), { swapFactory: SWAP })).toEqual([expect.stringMatching(/no swap order factory answers/)]);
    expect(await factoryProblems(chain({ shield: OTHER }), { shieldFactory: SHIELD })).toEqual([
      expect.stringMatching(/creates receivers other than this app's/),
    ]);
    expect(await factoryProblems(chain({ shield: null }), { shieldFactory: SHIELD })).toEqual([expect.stringMatching(/no shield receiver factory answers/)]);
  });

  it("a read that failed is the read's own error, tried again: never a mismatch", async () => {
    const down = new HttpRequestError({ url: "http://127.0.0.1:1", details: "fetch failed" });
    await expect(factoryProblems(chain({ swap: down }), { swapFactory: SWAP })).rejects.toBe(down);
  });

  it("nothing configured, nothing read", async () => {
    const c = chain({ swap: new Error("never asked") });
    expect(await factoryProblems(c, {})).toEqual([]);
    expect(c.asked).toEqual([]);
  });
});
