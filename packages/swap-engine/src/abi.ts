// Minimal ABI encoding for the adapters (no ethers dependency): static words, dynamic bytes, selectors.
import { keccak_256 } from "@noble/hashes/sha3";

export type AbiValue = { t: "uint"; v: bigint | number } | { t: "address"; v: string } | { t: "bytes32"; v: string | Buffer } | { t: "bytes"; v: string | Buffer };

export const selector = (sig: string) => Buffer.from(keccak_256(new TextEncoder().encode(sig))).subarray(0, 4);
export const selectorHex = (sig: string) => "0x" + selector(sig).toString("hex");

export function word(v: bigint | number): Buffer {
  const b = Buffer.alloc(32);
  let x = BigInt(v);
  if (x < 0n) throw new Error("negative word");
  for (let i = 31; i >= 0 && x > 0n; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  if (x > 0n) throw new Error("word overflow");
  return b;
}

export const hexBuf = (h: string | Buffer) => (Buffer.isBuffer(h) ? h : Buffer.from(h.replace(/^0x/, ""), "hex"));
export const padLeft32 = (b: Buffer) => Buffer.concat([Buffer.alloc(32 - b.length), b]);

/** Standard head/tail ABI encoding of a flat parameter list (static tuples are passed pre-flattened). */
export function encodeParams(params: AbiValue[]): Buffer {
  const head: Buffer[] = [], tail: Buffer[] = [];
  let tailOffset = params.length * 32;
  for (const p of params) {
    if (p.t === "uint") head.push(word(p.v));
    else if (p.t === "address") head.push(padLeft32(hexBuf(p.v)));
    else if (p.t === "bytes32") { const b = hexBuf(p.v); if (b.length !== 32) throw new Error("bytes32 length"); head.push(b); }
    else {
      const b = hexBuf(p.v);
      const padded = Buffer.concat([word(b.length), b, Buffer.alloc((32 - (b.length % 32)) % 32)]);
      head.push(word(tailOffset)); tail.push(padded); tailOffset += padded.length;
    }
  }
  return Buffer.concat([...head, ...tail]);
}

export function encodeCall(sig: string, params: AbiValue[]): `0x${string}` {
  return ("0x" + Buffer.concat([selector(sig), encodeParams(params)]).toString("hex")) as `0x${string}`;
}

/** Decode a flat static/dynamic parameter list given its types (uint|address|bytes32|bytes). */
export function decodeParams(data: Buffer, types: AbiValue["t"][]): (bigint | string | Buffer)[] {
  const out: (bigint | string | Buffer)[] = [];
  types.forEach((t, i) => {
    const w = data.subarray(i * 32, i * 32 + 32);
    if (t === "uint") out.push(BigInt("0x" + w.toString("hex")));
    else if (t === "address") out.push("0x" + w.subarray(12).toString("hex"));
    else if (t === "bytes32") out.push("0x" + w.toString("hex"));
    else { const off = Number(BigInt("0x" + w.toString("hex"))); const len = Number(BigInt("0x" + data.subarray(off, off + 32).toString("hex"))); out.push(Buffer.from(data.subarray(off + 32, off + 32 + len))); }
  });
  return out;
}
