// A lost answer (spec v2.0 §7.11; doc §75; V6 Stage 15): a submission the network swallowed may have reached the relayer;
// the wallet asks the relayer for the job spending its first nullifier (the hash and status only) instead of sending it
// again (the relayer refuses a second one).
import { describe, expect, it, vi } from "vitest";
import { RelayerRefusal, relayerJobFor, type RelayerSubmitRequest } from "../src/relayer";
import { AnswerLost, submitToRelayer } from "../src/privateTx";
import { classify } from "../src/operations/errors/catalog";

const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
const HASH = "0x" + "ab".repeat(32);

describe("relayerJobFor", () => {
  it("the job spending this nullifier, or none", async () => {
    const f = answer({ txHash: HASH, status: "mined" });
    expect(await relayerJobFor("http://127.0.0.1:8790/", [3n, 4n], f as never)).toEqual({ txHash: HASH });
    expect(f).toHaveBeenCalledWith("http://127.0.0.1:8790/jobs/by-nullifier/3", expect.objectContaining({ method: "GET" }));
    expect(
      await relayerJobFor("http://127.0.0.1:8790", [5n, 6n], answer({ error: "no job spends this nullifier", code: "unknown_nullifier" }, 404) as never),
    ).toBeNull();
    expect(await relayerJobFor("http://127.0.0.1:8790", [5n, 6n], answer({ txHash: "not a hash" }) as never), "a malformed answer is no job").toBeNull();
    await expect(relayerJobFor("http://127.0.0.1:8790", [5n, 6n], answer({}, 503) as never)).rejects.toThrow();
  });
});

describe("a retry refused after a lost answer (audit round 2, r44)", () => {
  const BODY: RelayerSubmitRequest = { proof: "0x", publicInputs: [], noteData: ["0x", "0x", "0x"], fee: { outputIndex: 0, amount: "1", noteSecret: "1" } };
  const refusal = new RelayerRefusal("relayer: fee 5 is below the current minimum 6 (fee_too_low)", "fee_too_low", 400);
  /** the first attempt's answer lost, every later one refused */
  const lostThenRefused = () => {
    let calls = 0;
    return async () => {
      if (++calls === 1) throw new TypeError("fetch failed");
      throw refusal;
    };
  };

  it("is an unknown outcome while the relayer cannot name the first attempt's job: never a refusal, which reads as 'not moved'", async () => {
    const e = await submitToRelayer("http://relayer.test", BODY, [3n, 4n], {}, { submit: lostThenRefused(), jobFor: async () => null }).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(AnswerLost);
    expect(classify(e)).toMatchObject({ code: "relayer_unreachable", fundsClass: "unknown" });
  }, 10_000);

  it("the job it names is the answer; a refusal of a first attempt stays a refusal: nothing was sent", async () => {
    const HASH_ = ("0x" + "cd".repeat(32)) as `0x${string}`;
    expect(await submitToRelayer("http://relayer.test", BODY, [3n, 4n], {}, { submit: lostThenRefused(), jobFor: async () => ({ txHash: HASH_ }) })).toEqual({
      txHash: HASH_,
    });
    await expect(
      submitToRelayer(
        "http://relayer.test",
        BODY,
        [3n, 4n],
        {},
        {
          submit: async () => {
            throw refusal;
          },
          jobFor: async () => null,
        },
      ),
    ).rejects.toBe(refusal);
  }, 10_000);
});
