// A lost answer (spec v2.0 §7.11; doc §75; V6 Stage 15): a submission the network swallowed may have reached the relayer;
// the wallet asks the relayer for the job spending its first nullifier (the hash and status only) instead of sending it
// again (the relayer refuses a second one).
import { describe, expect, it, vi } from "vitest";
import { relayerJobFor } from "../src/relayer";

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
