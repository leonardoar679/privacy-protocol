// The eleventh review round (2026-11-04), G11-1: the deployment check's pins are this build's own — the identifiers it compares with the
// core's are the protocol package's PROTOCOL_ID and CIRCUIT_ID (the ones every proof binds), and the hash it reads back from the core's
// hasher is the protocol package's Poseidon2 on the rate's own case. The contract boundary package does not depend on the protocol package,
// so the two are pinned here, where both are.
import { describe, expect, it } from "vitest";
import { bytesToHex } from "viem";
import { CORE_IDS, POSEIDON2_ONE_TWO_THREE } from "@privacy-wallet/contracts/deployments";
import { CIRCUIT_ID, PROTOCOL_ID } from "@privacy-wallet/protocol/payload";
import { hash } from "@privacy-wallet/protocol/poseidon2";

describe("the deployment check's pins are this build's (the eleventh review round, G11-1)", () => {
  it("the protocol and circuit identifiers are the ones the proofs bind", () => {
    expect(CORE_IDS.protocolId).toBe(bytesToHex(PROTOCOL_ID));
    expect(CORE_IDS.circuitId).toBe(bytesToHex(CIRCUIT_ID));
  });

  it("the hasher's answer is this build's Poseidon2 on [1, 2, 3] — the rate's own case, where the sponge skips its last permutation", () => {
    expect(POSEIDON2_ONE_TWO_THREE).toBe(hash([1n, 2n, 3n]));
    expect(POSEIDON2_ONE_TWO_THREE, "not the pair's").not.toBe(hash([1n, 2n]));
  });
});
