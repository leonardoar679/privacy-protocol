// The vendored prover (spec v3.0 §7.3; V7 Stage 6): the original's own code, pinned byte for byte under classic/vendor/
// (websnark 4c0af6a8, snarkjs 0.1.20, circomlib 3b492f9, blake-hash 2.0.0 — VENDORED.md lists each file's sha256), turned
// into the ES modules under src/prover/legacy/ by the literal replacements this file lists and nothing else: CommonJS
// into imports and exports, Node's Buffer into Uint8Array, the two `eval`s of the witness calculator into the precompiled
// templates (compile-circuit.mjs; the content security policy allows no eval), web3-utils into js-sha3, blake-hash's
// native binding into its own pure-JavaScript BLAKE-256, websnark's "a browser is a window" into "not Node" (the prover
// runs in a Web Worker), its worker count bounded, its randomness from globalThis.crypto. Every replacement must apply
// the number of times it says; `--write` regenerates the modules, `--check` (and test/vendored.test.ts) proves the
// committed modules are exactly what the pinned originals and these lists produce.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
export const VENDOR_DIR = join(here, "..", "vendor");
export const LEGACY_DIR = join(here, "..", "src", "prover", "legacy");
export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

const BN254_R = "21888242871839275222246405745257275088548364400416034343698204186575808495617";

/** A replacement: the exact text, what replaces it, and how many times it must occur (1 unless said). */
const r = (from, to, count = 1) => ({ from, to, count });

/** The conversions, file by file. */
export const FILES = [
  {
    from: "snarkjs-0.1.20/src/bigint.js",
    to: "bigint.js",
    replace: [
      r('const bigInt = require("big-integer");', 'import bigInt from "big-integer";'),
      r("module.exports = wBigInt;", "export default wBigInt;"),
      r("    const buff = Buffer.alloc(len);", "    const buff = new Uint8Array(len);", 2),
    ],
  },
  {
    from: "snarkjs-0.1.20/src/futils.js",
    to: "futils.js",
    replace: [
      r('const bigInt = require("./bigint.js");', 'import bigInt from "./bigint.js";'),
      r("exports.mulScalar = (F, base, e) =>{", "export const mulScalar = (F, base, e) =>{"),
      r("exports.exp = (F, base, e) =>{", "export const exp = (F, base, e) =>{"),
    ],
  },
  {
    from: "snarkjs-0.1.20/src/zqfield.js",
    to: "zqfield.js",
    replace: [
      r(
        'const bigInt = require("./bigint");\nconst fUtils = require("./futils.js");',
        'import bigInt from "./bigint.js";\nimport * as fUtils from "./futils.js";',
      ),
      r('        return module.require("crypto").randomBytes(1)[0];', "        return globalThis.crypto.getRandomValues(new Uint8Array(1))[0];"),
      r("module.exports = ZqField;", "export default ZqField;"),
    ],
  },
  {
    from: "snarkjs-0.1.20/src/stringifybigint.js",
    to: "stringifybigint.js",
    replace: [
      r(
        'const bigInt = require("./bigint.js");\n\nmodule.exports.stringifyBigInts = stringifyBigInts;\nmodule.exports.unstringifyBigInts = unstringifyBigInts;',
        'import bigInt from "./bigint.js";\n\nexport { stringifyBigInts, unstringifyBigInts };',
      ),
    ],
  },
  {
    from: "snarkjs-0.1.20/src/calculateWitness.js",
    to: "calculateWitness.js",
    replace: [
      r('const bigInt = require("./bigint");\n\nmodule.exports = calculateWitness;', 'import bigInt from "./bigint.js";\n\nexport default calculateWitness;'),
      // the original ran a component the moment its last input was set, nested inside that setter: one withdrawal is a
      // chain of about 8,800 components (220 MiMC rounds × 2 × 20 levels), deeper than a Web Worker's stack. A ready
      // component now waits in `pending`; when a signal not yet set is read, drainFor() runs the waiting components — last
      // ready first, so a parent runs before a child whose inputs alias its own — until the signal is set, and drain() runs
      // the rest once the inputs are all set. The same values (test/prover.test.ts holds the witness, signal for signal, to
      // the pristine original's), a flat stack.
      r(
        "        this.notInitSignals = {};\n        for (let c in this.circuit.components) {",
        "        this.notInitSignals = {};\n        this.pending = []; // components whose inputs are all set, run by drain() in a loop (never nested: a Web Worker's stack is small)\n        for (let c in this.circuit.components) {",
      ),
      r(
        "        callComponents.map( (c) => {\n            if (this.notInitSignals[c] == 0) this.triggerComponent(c);\n        });\n        return this.witness[sId];",
        "        for (let i=0; i<callComponents.length; i++) {\n            if (this.notInitSignals[callComponents[i]] == 0) this.pending.push(callComponents[i]);\n        }\n        return this.witness[sId];",
      ),
      r(
        "    getSignalFullName(fullName) {\n        const sId = this.circuit.getSignalIdx(fullName);",
        '    // runs the waiting components, last ready first, until the signal is set (a read of a signal not yet set)\n    drainFor(sId) {\n        while (this.pending.length && typeof(this.witness[sId]) == "undefined") {\n            const c = this.pending.pop();\n            if (this.notInitSignals[c] == 0) this.triggerComponent(c);\n        }\n    }\n\n    // runs every waiting component, and those they make ready (once the inputs are all set)\n    drain() {\n        while (this.pending.length) {\n            const c = this.pending.pop();\n            if (this.notInitSignals[c] == 0) this.triggerComponent(c);\n        }\n    }\n\n    getSignalFullName(fullName) {\n        const sId = this.circuit.getSignalIdx(fullName);\n        if (typeof(this.witness[sId]) == "undefined") this.drainFor(sId);',
      ),
      r(
        "    for (let i=0; i<circuit.nInputs; i++) {\n        const idx = circuit.inputIdx(i);",
        "    ctx.drain();\n\n    for (let i=0; i<circuit.nInputs; i++) {\n        const idx = circuit.inputIdx(i);",
      ),
    ],
  },
  {
    from: "snarkjs-0.1.20/src/circuit.js",
    to: "circuit.js",
    replace: [
      r('const bigInt = require("./bigint.js");', 'import bigInt from "./bigint.js";'),
      r('const calculateWitness = require("./calculateWitness.js");', 'import calculateWitness from "./calculateWitness.js";'),
      r("module.exports = class Circuit {\n    constructor(circuitDef) {", "export default class Circuit {\n    constructor(circuitDef, compiled) {"),
      r(
        "        this.nConstraints = circuitDef.constraints.length;",
        "        this.nConstraints = (circuitDef.constraints ?? []).length; // the witness file carries no constraints (compile-circuit.mjs)",
      ),
      r("        this.constraints = circuitDef.constraints;", "        this.constraints = circuitDef.constraints ?? [];"),
      r(
        '        this.templates = {};\n        for (let t in circuitDef.templates) {\n            this.templates[t] = eval(" const __f= " +circuitDef.templates[t] + "\\n__f");\n        }\n\n        this.functions = {};\n        for (let f in circuitDef.functions) {\n            this.functions[f] = {\n                params: circuitDef.functions[f].params,\n                func: eval(" const __f= " +circuitDef.functions[f].func + "\\n__f;")\n            };\n        }',
        "        // no eval (the content security policy): the templates and functions precompiled from the pinned circuit (compile-circuit.mjs)\n        this.templates = compiled.templates;\n        this.functions = compiled.functions;",
      ),
    ],
  },
  {
    from: "websnark/tools/stringifybigint.js",
    to: "websnark-stringifybigint.js",
    replace: [
      r(
        'const bigInt = require("big-integer");\n\nmodule.exports.stringifyBigInts = stringifyBigInts;\nmodule.exports.unstringifyBigInts = unstringifyBigInts;\nmodule.exports.hexifyBigInts = hexifyBigInts;\nmodule.exports.unhexifyBigInts = unhexifyBigInts;',
        'import bigInt from "big-integer";\n\nexport { stringifyBigInts, unstringifyBigInts, hexifyBigInts, unhexifyBigInts };',
      ),
    ],
  },
  {
    from: "websnark/src/utils.js",
    to: "websnark-utils.js",
    replace: [
      r(
        'const bigInt = require("big-integer");\nconst Circuit = require("snarkjs/src/circuit");\nconst bigInt2 = require("snarkjs/src/bigint");\nconst hexifyBigInts = require("../tools/stringifybigint").hexifyBigInts;\nconst unhexifyBigInts = require("../tools/stringifybigint").unhexifyBigInts;\nconst stringifyBigInts = require("../tools/stringifybigint").stringifyBigInts;\nconst unstringifyBigInts = require("../tools/stringifybigint").unstringifyBigInts;\nconst stringifyBigInts2 = require("snarkjs/src/stringifybigint").stringifyBigInts;\nconst unstringifyBigInts2 = require("snarkjs/src/stringifybigint").unstringifyBigInts;',
        'import bigInt from "big-integer";\nimport Circuit from "./circuit.js";\nimport bigInt2 from "./bigint.js";\nimport { hexifyBigInts, stringifyBigInts, unstringifyBigInts } from "./websnark-stringifybigint.js";\nimport { stringifyBigInts as stringifyBigInts2, unstringifyBigInts as unstringifyBigInts2 } from "./stringifybigint.js";',
      ),
      r(
        "function  genWitness(input, circuitJson) {\n    const circuit = new Circuit(unstringifyBigInts2(circuitJson));",
        "function  genWitness(input, circuitJson, compiled) {\n    const circuit = new Circuit(unstringifyBigInts2(circuitJson), compiled);",
      ),
      r(
        "async function genWitnessAndProve(groth16, input, circuitJson, provingKey) {\n    const witnessData = genWitness(input, circuitJson);",
        "async function genWitnessAndProve(groth16, input, circuitJson, provingKey, compiled) {\n    const witnessData = genWitness(input, circuitJson, compiled);",
      ),
      r(
        "module.exports = {bigInt2BytesLE, bigInt2U32LE, toSolidityInput, genWitnessAndProve};",
        "export {bigInt2BytesLE, bigInt2U32LE, toSolidityInput, genWitness, genWitnessAndProve, convertWitness};",
      ),
    ],
  },
  {
    from: "websnark/src/groth16.js",
    to: "groth16.js",
    replace: [
      r(
        'const bigInt = require("big-integer");\nconst groth16_wasm = require("../build/groth16_wasm.js");\nconst assert = require("assert");\n\nconst inBrowser = (typeof window !== "undefined");\nlet NodeWorker;\nlet NodeCrypto;\nif (!inBrowser) {\n    NodeWorker = require("worker_threads").Worker;\n    NodeCrypto = require("crypto");\n}',
        'import bigInt from "big-integer";\nimport * as groth16_wasm from "./groth16_wasm.js";\nconst assert = (c) => { if (!c) throw new Error("assertion failed"); };\n\n// a browser page or a Web Worker (the Classic prover runs in one); Node otherwise (the tests)\nconst inBrowser = !(typeof process !== "undefined" && process.versions && process.versions.node);\nlet NodeWorker;\nlet NodeCrypto;\nasync function loadNode() {\n    if (inBrowser || NodeWorker) return;\n    const wt = "node:worker_threads";\n    const cr = "node:crypto";\n    NodeWorker = (await import(/* @vite-ignore */ wt)).Worker;\n    NodeCrypto = await import(/* @vite-ignore */ cr);\n}',
      ),
      r("    const defaultParams = { wasmInitialMemory: 5000 };", "    const defaultParams = { wasmInitialMemory: 5000, maxWorkers: 8 };"),
      // a sub-worker's scratch — the witness it was handed, the polynomials — zeroed before its allocation pointer is reset (the fifth
      // review round, 2026-11-03): the bytes had stayed in the WebAssembly memory for the worker's lifetime
      r(
        "            i32[0] = oldAlloc;\n            self.postMessage(data.result, [data.result]);",
        "            new Uint8Array(memory.buffer).fill(0, oldAlloc, i32[0]); // the scratch zeroed before the pointer goes back (the fifth review round, 2026-11-03)\n            i32[0] = oldAlloc;\n            self.postMessage(data.result, [data.result]);",
        3,
      ),
      r(
        "    const groth16 = new Groth16();\n\n    groth16.q = bigInt(",
        "    const groth16 = new Groth16();\n    await loadNode();\n\n    groth16.q = bigInt(",
      ),
      r(
        '    if ((typeof(navigator) === "object") && navigator.hardwareConcurrency) {\n        concurrency = navigator.hardwareConcurrency;\n    } else {\n        concurrency = 8;\n    }',
        '    if ((typeof(navigator) === "object") && navigator.hardwareConcurrency) {\n        concurrency = Math.max(1, Math.min(navigator.hardwareConcurrency, defaultParams.maxWorkers));\n    } else {\n        concurrency = Math.max(1, Math.min(8, defaultParams.maxWorkers));\n    }',
      ),
      r(
        '        } else if (data.command == "TERMINATE") {\n            process.exit();\n        }',
        '        } else if (data.command == "TERMINATE") {\n            if (typeof process !== "undefined" && process.exit) process.exit(); else self.close();\n        }',
      ),
      r(
        "        if (inBrowser) {\n            window.crypto.getRandomValues(rnd);\n            this.putBin(pr, rnd);\n\n            window.crypto.getRandomValues(rnd);\n            this.putBin(ps, rnd);\n        } else {",
        "        if (inBrowser) {\n            globalThis.crypto.getRandomValues(rnd);\n            this.putBin(pr, rnd);\n\n            globalThis.crypto.getRandomValues(rnd);\n            this.putBin(ps, rnd);\n        } else {",
      ),
      r("module.exports = build;", "export default build;"),
    ],
  },
  {
    from: "websnark/build/groth16_wasm.js",
    to: "groth16_wasm.js",
    generate: (text) => {
      const b64 = /new Buffer\("([A-Za-z0-9+/=]+)", "base64"\)/.exec(text)?.[1];
      const pq = /exports\.pq = (\d+);/.exec(text)?.[1];
      const pr = /exports\.pr = (\d+);/.exec(text)?.[1];
      if (!b64 || !pq || !pr) throw new Error("groth16_wasm.js: the base64 module, pq or pr not found");
      return [
        "// The same WebAssembly module as the original's, its base64 decoded without Node's Buffer; pq and pr as the original names them.",
        `const b64 = "${b64}";`,
        "const bin = atob(b64);",
        "export const code = Uint8Array.from(bin, (c) => c.charCodeAt(0));",
        `export const pq = ${pq};`,
        `export const pr = ${pr};`,
        "",
      ].join("\n");
    },
  },
  {
    from: "circomlib/src/babyjub.js",
    to: "babyjub.js",
    replace: [
      r(
        'const bn128 = require("snarkjs").bn128;\nconst bigInt = require("snarkjs").bigInt;\n\nexports.addPoint = addPoint;\nexports.mulPointEscalar = mulPointEscalar;\nexports.inCurve = inCurve;\nexports.inSubgroup = inSubgroup;\nexports.packPoint = packPoint;\nexports.unpackPoint = unpackPoint;\nexports.Generator = [',
        `import bigInt from "./bigint.js";\nimport ZqField from "./zqfield.js";\n\n// snarkjs 0.1's bn128.r and bn128.Fr (the scalar field of BN254): the two this module uses\nconst bn128 = { r: bigInt("${BN254_R}") };\nbn128.Fr = new ZqField(bn128.r);\n\nexport { addPoint, mulPointEscalar, inCurve, inSubgroup, packPoint, unpackPoint };\nexport const Generator = [`,
      ),
      r("exports.Base8 = [", "export const Base8 = ["),
      r(
        'exports.order = bigInt("21888242871839275222246405745257275088614511777268538073601725287587578984328");\nexports.subOrder = exports.order.shr(3);\nexports.p = bn128.r;\nexports.A = bigInt("168700");\nexports.D = bigInt("168696");',
        'export const order = bigInt("21888242871839275222246405745257275088614511777268538073601725287587578984328");\nexport const subOrder = order.shr(3);\nexport const p = bn128.r;\nexport const A = bigInt("168700");\nexport const D = bigInt("168696");',
      ),
      r("exports.D", "D", 4),
      r("exports.A", "A", 3),
      r("exports.subOrder", "subOrder", 1),
      r("exports.p", "p", 2),
      r("    const buff = Buffer.from(_buff);", "    const buff = Uint8Array.from(_buff);"),
    ],
  },
  {
    from: "circomlib/src/pedersenHash.js",
    to: "pedersenHash.js",
    replace: [
      r(
        'const bn128 = require("snarkjs").bn128;\nconst bigInt = require("snarkjs").bigInt;\nconst babyJub = require("./babyjub");\nconst createBlakeHash = require("blake-hash");',
        'import bigInt from "./bigint.js";\nimport * as babyJub from "./babyjub.js";\nimport Blake256 from "./blake256.js";',
      ),
      r("exports.hash = pedersenHash;\nexports.getBasePoint = getBasePoint;", "export { pedersenHash as hash, getBasePoint };"),
      r(
        '        const h = createBlakeHash("blake256").update(S).digest();',
        "        const b = new Blake256(); b.update(new TextEncoder().encode(S)); const h = b.digest(); // the generator seeds are ASCII (the engine's update returns nothing)",
      ),
    ],
  },
  {
    from: "circomlib/src/mimcsponge.js",
    to: "mimcsponge.js",
    replace: [
      r(
        'const bn128 = require("snarkjs").bn128;\nconst bigInt = require("snarkjs").bigInt;\nconst Web3Utils = require("web3-utils");\nconst F = bn128.Fr;',
        `import bigInt from "./bigint.js";\nimport ZqField from "./zqfield.js";\nimport { keccak256 } from "js-sha3";\n\n// snarkjs 0.1's bn128.Fr; web3-utils' keccak256 hashes a 0x string as bytes and any other string as UTF-8 (the constants chain)\nconst F = new ZqField(bigInt("${BN254_R}"));\nconst hexBytes = (h) => Uint8Array.from(h.slice(2).match(/../g) ?? [], (x) => parseInt(x, 16));\nconst Web3Utils = { keccak256: (s) => "0x" + keccak256(/^0x([0-9a-fA-F]{2})*$/.test(s) ? hexBytes(s) : s) };`,
      ),
      r("exports.getIV = (seed) => {", "export const getIV = (seed) => {"),
      r("    const cn = bigInt(Web3Utils.toBN(c).toString());", "    const cn = bigInt(BigInt(c).toString());"),
      r("exports.getConstants = (seed, nRounds) => {", "export const getConstants = (seed, nRounds) => {"),
      r(
        "        const n1 = Web3Utils.toBN(c).mod(Web3Utils.toBN(F.q.toString()));\n        const c2 = Web3Utils.padLeft(Web3Utils.toHex(n1), 64);\n        cts[i] = bigInt(Web3Utils.toBN(c2).toString());",
        "        const n1 = BigInt(c) % BigInt(F.q.toString());\n        cts[i] = bigInt(n1.toString());",
      ),
      r("const cts = exports.getConstants(SEED, NROUNDS);", "const cts = getConstants(SEED, NROUNDS);"),
      r("exports.hash = (_xL_in, _xR_in, _k) =>{", "export const hash = (_xL_in, _xR_in, _k) =>{"),
      r("exports.multiHash = (arr, key, numOutputs) => {", "export const multiHash = (arr, key, numOutputs) => {"),
      r("      const S = exports.hash(R, C, key);", "      const S = hash(R, C, key);", 2),
    ],
  },
  {
    from: "blake-hash-2.0.0/lib/blake.js",
    to: "blake.js",
    replace: [r("Blake.padding = Buffer.from([", "Blake.padding = Uint8Array.from(["), r("module.exports = Blake", "export default Blake")],
  },
  {
    from: "blake-hash-2.0.0/lib/blake256.js",
    to: "blake256.js",
    replace: [
      r(
        "const Blake = require('./blake')\n\nconst zo = Buffer.from([0x01])\nconst oo = Buffer.from([0x81])",
        "import Blake from './blake.js'\n\nconst zo = Uint8Array.from([0x01])\nconst oo = Uint8Array.from([0x81])\nconst readUInt32BE = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0\nconst writeUInt32BE = (b, v, o) => { b[o] = v >>> 24; b[o + 1] = (v >>> 16) & 0xff; b[o + 2] = (v >>> 8) & 0xff; b[o + 3] = v & 0xff }",
      ),
      r("module.exports = class Blake256 extends Blake {", "export default class Blake256 extends Blake {"),
      r("    this._block = Buffer.alloc(64)", "    this._block = new Uint8Array(64)"),
      r("    for (i = 0; i < 16; ++i) m[i] = this._block.readUInt32BE(i * 4)", "    for (i = 0; i < 16; ++i) m[i] = readUInt32BE(this._block, i * 4)"),
      r(
        "    const msglen = Buffer.alloc(8)\n    msglen.writeUInt32BE(hi, 0)\n    msglen.writeUInt32BE(lo, 4)",
        "    const msglen = new Uint8Array(8)\n    writeUInt32BE(msglen, hi, 0)\n    writeUInt32BE(msglen, lo, 4)",
      ),
      r(
        "    const buffer = Buffer.alloc(32)\n    for (let i = 0; i < 8; ++i) buffer.writeUInt32BE(this._h[i], i * 4)\n    return buffer",
        "    const buffer = new Uint8Array(32)\n    for (let i = 0; i < 8; ++i) writeUInt32BE(buffer, this._h[i], i * 4)\n    return buffer",
      ),
    ],
  },
];

const countOf = (text, needle) => text.split(needle).length - 1;

/** The module a pristine file becomes: the header, then the file with every replacement applied the number of times it says. */
export function convert(spec, pristine) {
  const sha = sha256Hex(pristine);
  const header = `// Generated by classic/scripts/vendor.mjs from classic/vendor/${spec.from} (sha256 ${sha}): the pinned original with the\n// replacements the script lists — nothing else is changed. Do not edit; edit the list and run \`node scripts/vendor.mjs --write\`.\n`;
  if (spec.generate) return header + spec.generate(pristine.toString("utf8"));
  let text = pristine.toString("utf8");
  for (const { from, to, count } of spec.replace) {
    const n = countOf(text, from);
    if (n !== count) throw new Error(`${spec.from}: the replacement\n${from}\noccurs ${n} time(s), not ${count}`);
    text = text.split(from).join(to);
  }
  return header + text;
}

export function convertAll(vendorDir = VENDOR_DIR) {
  return FILES.map((spec) => {
    const pristine = readFileSync(join(vendorDir, spec.from));
    return { spec, sha256: sha256Hex(pristine), text: convert(spec, pristine) };
  });
}

/** What differs between the committed modules and a fresh conversion (empty when they agree). */
export function checkLegacy(vendorDir = VENDOR_DIR, legacyDir = LEGACY_DIR) {
  const problems = [];
  for (const { spec, text } of convertAll(vendorDir)) {
    const file = join(legacyDir, spec.to);
    if (!existsSync(file)) problems.push(`${spec.to}: missing (node scripts/vendor.mjs --write)`);
    else if (readFileSync(file, "utf8") !== text) problems.push(`${spec.to}: differs from the conversion of ${spec.from}`);
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--write")) {
    mkdirSync(LEGACY_DIR, { recursive: true });
    for (const { spec, text, sha256 } of convertAll()) {
      writeFileSync(join(LEGACY_DIR, spec.to), text);
      console.log(`wrote src/prover/legacy/${spec.to} from vendor/${spec.from} (${sha256.slice(0, 16)}…)`);
    }
  } else {
    const problems = checkLegacy();
    for (const p of problems) console.error(`FAIL  ${p}`);
    if (!problems.length) console.log(`PASS  vendor: ${FILES.length} modules under src/prover/legacy are the pinned originals with the listed replacements`);
    process.exit(problems.length ? 1 : 0);
  }
}
