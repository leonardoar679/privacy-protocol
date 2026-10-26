// A small ZIP reader for the original UI's event caches (static/events/*.json.zip: one deflated file each): the central
// directory read from the end, every entry inflated with node:zlib. No ZIP64, no encryption — the caches need neither.
import { inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Every entry of the archive: name → bytes. */
export function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive (no end of central directory)");
  const entries = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(offset) !== CENTRAL) throw new Error("a central directory entry is missing");
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (buf.readUInt32LE(localOffset) !== LOCAL) throw new Error(`${name}: the local header is missing`);
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const data = buf.subarray(dataStart, dataStart + compressedSize);
    let bytes;
    if (method === 0) bytes = Buffer.from(data);
    else if (method === 8) bytes = inflateRawSync(data);
    else throw new Error(`${name}: compression method ${method} is not supported`);
    if (bytes.length !== size) throw new Error(`${name}: ${bytes.length} bytes inflated, the directory says ${size}`);
    out.set(name, bytes);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}
