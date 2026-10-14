// The relayer's logs (spec v2.0 §17, §19; doc §67, §83; V6 Stage 15): what the relayer writes to its console names
// itself, never a user — no request, body, header or caller address, no proof, payload, note secret or recipient. A
// source scan over every console call of apps/relayer/src (the API's own log gate is apps/api/test/logs.test.ts).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src", import.meta.url));
const FORBIDDEN = /\b(req|request|body|headers|remoteAddress|caller|proof|publicInputs|noteData|noteSecret|recipient|nullifiers?|feeNoteSecret|params)\b/;

/** Every console call with its arguments (to the matching parenthesis). */
function consoleCalls(text: string): string[] {
  const out: string[] = [];
  const re = /console\.(log|info|warn|error|debug)\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
    }
    out.push(text.slice(m.index, i));
  }
  return out;
}

describe("the relayer's logs (doc §67)", () => {
  const calls = readdirSync(src)
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) => consoleCalls(readFileSync(join(src, f), "utf8")).map((c) => ({ file: f, call: c })));
  it("every console call names the relayer or an error's message, never a user's request", () => {
    expect(calls.length).toBeGreaterThan(0);
    for (const { file, call } of calls) expect(call, `${file}: ${call}`).not.toMatch(FORBIDDEN);
  });
  it("nothing is logged per request: the HTTP handler and the edge have no console call", () => {
    for (const f of ["edge.ts"]) expect(consoleCalls(readFileSync(join(src, f), "utf8")), f).toEqual([]);
    const server = readFileSync(join(src, "server.ts"), "utf8");
    const handler = server.slice(server.indexOf("createServer("), server.indexOf("server.listen("));
    expect(consoleCalls(handler), "the request handler").toEqual([]);
  });
});
