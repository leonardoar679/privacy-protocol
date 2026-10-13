// Fault-injection harness for the LIVE adversarial tests (plan §71, §74): wraps globalThis.fetch so a
// test can take a provider offline, delay it, or rewrite what its API returns, while every other call
// still reaches the real network. Nothing is recorded for replay; every run is live.
export interface TamperRule {
  /** substring (or regex) of the URL this rule applies to */
  match: string | RegExp;
  /** simulate an outage: the fetch rejects with a TypeError, like a DNS / connection failure */
  fail?: boolean;
  /** replace the HTTP status of the real response */
  status?: number;
  /** rewrite a JSON body: receives the parsed real body, returns the replacement */
  json?: (body: any, url: string, init?: RequestInit) => any;
  /** rewrite the raw text body */
  text?: (body: string, url: string) => string;
  /** add latency before the real call */
  delayMs?: number;
  /** synthesize the response without touching the network (the `json` function receives `{}`); for status-mapping tests whose real body is irrelevant */
  offline?: boolean;
}
export interface RecordedCall { url: string; method: string; headers: Record<string, string>; body?: string }

const realFetch = globalThis.fetch;
export const matches = (rule: TamperRule, url: string) => (typeof rule.match === "string" ? url.includes(rule.match) : rule.match.test(url));

/** Run `fn` with the rules installed and every call recorded; fetch is restored afterwards, also on failure. */
export async function withTamper<T>(rules: TamperRule[], fn: (calls: RecordedCall[]) => Promise<T>): Promise<T> {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input.url);
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h) {
      if (h instanceof Headers) h.forEach((v, k) => { headers[k] = v; });
      else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = v;
      else Object.assign(headers, h);
    }
    calls.push({ url, method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : undefined });
    const rule = rules.find((r) => matches(r, url));
    if (!rule) return realFetch(input, init);
    if (rule.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
    if (rule.fail) throw new TypeError(`fetch failed (simulated outage of ${url})`);
    if (rule.offline) return new Response(JSON.stringify(rule.json ? rule.json({}, url, init) : {}), { status: rule.status ?? 200, headers: { "content-type": "application/json" } });
    const res = await realFetch(input, init);
    if (!rule.json && !rule.text && rule.status === undefined) return res;
    let body = await res.text();
    if (rule.json) {
      let parsed: any;
      try { parsed = JSON.parse(body); } catch { parsed = body; }
      body = JSON.stringify(rule.json(parsed, url, init));
    }
    if (rule.text) body = rule.text(body, url);
    return new Response(body, { status: rule.status ?? res.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** Record every call without changing anything (the §72 flow test). */
export const recordFetch = <T>(fn: (calls: RecordedCall[]) => Promise<T>) => withTamper<T>([], fn);

/** Replace the first occurrence of a hex pattern inside hex data (same length in and out). */
export function replaceHex(data: string, from: string, to: string): string {
  const f = from.replace(/^0x/, "").toLowerCase(), t = to.replace(/^0x/, "").toLowerCase();
  if (f.length !== t.length) throw new Error("replaceHex: lengths differ");
  const i = data.toLowerCase().indexOf(f);
  if (i < 0) throw new Error("replaceHex: pattern not found");
  return data.slice(0, i) + t + data.slice(i + f.length);
}

/** Overwrite the 32-byte word that starts `byteOffset` bytes into the calldata (selector included). */
export function setWord(data: string, byteOffset: number, word: string | bigint): string {
  const w = typeof word === "bigint" ? word.toString(16).padStart(64, "0") : word.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  if (w.length !== 64) throw new Error("setWord: word must be 32 bytes");
  const i = 2 + byteOffset * 2;
  if (i + 64 > data.length) throw new Error("setWord: offset beyond calldata");
  return data.slice(0, i) + w + data.slice(i + 64);
}

/** 32-byte little-endian hex of an unsigned integer (Chainflip's cfParameters encode min_price this way). */
export function leHex32(x: bigint): string {
  let out = "";
  let v = x;
  for (let i = 0; i < 32; i++) { out += (v & 0xffn).toString(16).padStart(2, "0"); v >>= 8n; }
  return out;
}

export const padAddress = (a: string) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
