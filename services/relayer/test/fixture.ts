// The forge e2e fixture as a relayer request (shared by the relayer's tests): transaction 0 of contracts/test/e2e —
// Alice's withdrawal of 0.6 ETH paying a 0.05 ETH private fee note to the relayer whose seed the fixture uses.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import type { SubmitRequest } from "../src/relayer";

export const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fixture = join(FIXTURE_ROOT, "contracts/test/e2e/E2EFixture.sol");
/** the fixture and the circuit vectors are checked in; absent only in a partial checkout */
export const have = existsSync(fixture) && existsSync(join(FIXTURE_ROOT, "circuits/test/fixtures/e2e/tx1.json"));

// ---- the fixture's transaction 0 as a relayer request ----
export function fixtureRequest(): { req: SubmitRequest; deployment: any } {
  const sol = readFileSync(fixture, "utf8");
  const words = (s: string) => s.split(",").map((x) => BigInt(x.replace(/uint256\(|\)/g, "").trim()));
  const pm = sol.match(/if \(t == 0\) \{\s*a = \[([^\]]+)\];\s*b = \[\[([^\]]+)\], \[([^\]]+)\]\];\s*c = \[([^\]]+)\];/);
  if (!pm) throw new Error("proof(0) not found in E2EFixture.sol");
  const a = words(pm[1]), b0 = words(pm[2]), b1 = words(pm[3]), c = words(pm[4]);
  const proof = ("0x" + [a[0], a[1], b0[0], b0[1], b1[0], b1[1], c[0], c[1]].map((w) => w.toString(16).padStart(64, "0")).join("")) as Hex;
  const um = sol.match(/if \(t == 0\) \{\s*p = \[uint256\(([^)]+)\),([^\]]+)\];/);
  if (!um) throw new Error("pub(0) not found");
  const publicInputs = [um[1], ...um[2].split(",")].map((s) => BigInt(s.trim()).toString());
  const meta = JSON.parse(readFileSync(join(FIXTURE_ROOT, "circuits/test/fixtures/e2e/meta.json"), "utf8"));
  const tx1 = JSON.parse(readFileSync(join(FIXTURE_ROOT, "circuits/test/fixtures/e2e/tx1.json"), "utf8"));
  const deployment = JSON.parse(readFileSync(join(FIXTURE_ROOT, "contracts/test/e2e/deployment.json"), "utf8"));
  return { req: { proof, publicInputs, noteData: meta.noteData[0], fee: { outputIndex: 1, amount: tx1.outAmount[1], noteSecret: tx1.outNoteSecret[1] } }, deployment };
}
