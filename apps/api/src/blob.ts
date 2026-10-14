// The order's blob (spec v2.0 §15): the engine's Order and its prepared execution as JSON with every bigint tagged, so
// what is read back is what the engine wrote. It lives in `operations.order_blob` until finalize nulls it.

const TAG = "$bigint";

export const encodeBlob = (x: unknown): string => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? { [TAG]: v.toString() } : v));

export const decodeBlob = <T>(s: string): T =>
  JSON.parse(s, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v[TAG] === "string" ? BigInt(v[TAG]) : v,
  ) as T;

/** An answer's JSON: bigints as decimal strings (the wire format the wallet reads). */
export const wire = (x: unknown): unknown => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
