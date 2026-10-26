// The recorded proof against the deployed verifier (spec v3.0 §7.3; V7 Stage 6; verify-all --live): the shared Verifier
// 0xce17…557a accepts vectors/proof.json through eth_call verifyProof(bytes, uint256[6]) and rejects it with the
// recipient bent — the rung of the correctness ladder that ties the vendored stack to the chain.
import { describe, expect, it } from "vitest";
import { makeRpc, PUBLIC_RPC_URLS, readPins } from "../../scripts/deployment.mjs";
import { verifiedOf, verifyProofCall } from "../../src/prover/verify";
import vector from "../../vectors/proof.json";

const urls = (process.env.CLASSIC_RPC_URLS ?? PUBLIC_RPC_URLS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

describe("the deployed verifier", () => {
  it("accepts the recorded proof and rejects it with the recipient bent", async () => {
    const pins = readPins();
    expect(pins).not.toBeNull();
    const verifier = pins!.verifier.address as `0x${string}`;
    expect(verifier).toBe("0xce172ce1f20ec0b3728c9965470eaf994a03557a");
    const rpc = makeRpc(urls);
    const proof = vector.proof as `0x${string}`;
    const good = verifyProofCall(verifier, proof, vector.publicSignals);
    expect(verifiedOf(await rpc("eth_call", [{ to: good.to, data: good.data }, "latest"]))).toBe(true);
    const bent = vector.publicSignals.map((x, i) => (i === 2 ? (BigInt(x) + 1n).toString() : x));
    const bad = verifyProofCall(verifier, proof, bent);
    expect(verifiedOf(await rpc("eth_call", [{ to: bad.to, data: bad.data }, "latest"]))).toBe(false);
  }, 120_000);
});
