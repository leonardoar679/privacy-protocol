// The Classic deployment's verification logic, offline (spec v3.0 §7.2; V7 Stage 5): the cached Sourcify records are
// internally consistent (the chain's code Sourcify saw equals its recompilation modulo the transformations; the Hasher
// library links to one address at both sites; the metadata hash is the record's), a tampered byte is caught, the
// hand-made ABI encodes the calls the pools answer, the verifier's key parses from its source with six public inputs,
// the committed pins agree with the records, and a rebuild with the pinned compiler reproduces the chain's code when
// the build is cached on this machine (skipped, and said so, otherwise). The chain itself is the live suite's.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPILERS, compilerCached, loadCompiler } from "../scripts/compilers.mjs";
import {
  blankTransformations,
  callData,
  compareRuntime,
  CONTRACTS,
  diffPins,
  encodeAddress,
  parseVerifyingKey,
  PINS_FILE,
  POOL_IDS,
  readPins,
  readRecord,
  rebuildRecord,
  selector,
  sha256Hex,
  standardJsonOf,
  transformationValues,
  VERIFIED_DIR,
  wordAddress,
  wordNumber,
  words,
} from "../scripts/deployment.mjs";

const records = readdirSync(VERIFIED_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));
/** The pool ids as the keys they are (the JS module freezes a plain string array). */
const POOLS = POOL_IDS as readonly ("eth-0.1" | "eth-1" | "eth-10" | "eth-100")[];

describe("the verified records (contracts/verified)", () => {
  it("cover every contract the app pins, on chain 1, each a Sourcify match with its sources and bytecodes", () => {
    for (const c of Object.values(CONTRACTS)) {
      const r = readRecord(c.record);
      expect(r.chainId, c.record).toBe("1");
      expect(r.address.toLowerCase(), c.record).toBe(c.address);
      expect(["match", "exact_match"], c.record).toContain(r.match);
      expect(Object.keys(r.sources).length, c.record).toBeGreaterThan(0);
      expect(r.runtimeBytecode.onchainBytecode, c.record).toMatch(/^0x[0-9a-f]+$/);
      expect(r.runtimeBytecode.recompiledBytecode, c.record).toMatch(/^0x[0-9a-f]+$/);
      expect(COMPILERS, `${c.record}: a pinned compiler`).toHaveProperty(r.compilation.compilerVersion);
    }
    expect(records.length).toBeGreaterThanOrEqual(Object.keys(CONTRACTS).length);
  });

  it("the chain's code Sourcify saw equals its recompilation modulo the transformations; the Hasher links once; the metadata hash is the record's", () => {
    for (const c of Object.values(CONTRACTS)) {
      const r = readRecord(c.record);
      const cmp = compareRuntime(r, r.runtimeBytecode.onchainBytecode);
      expect(cmp.problems, c.record).toEqual([]);
      expect(cmp.sameAsSourcify).toBe(true);
      expect(cmp.matchesRecompiled).toBe(true);
      expect(cmp.matchesRebuilt).toBeNull();
      if (c.kind === "pool") {
        const hasher = Object.entries(cmp.libraries).find(([id]) => id.endsWith(":Hasher"));
        expect(hasher, `${c.record}: the Hasher library`).toBeDefined();
        expect(hasher![1]).toMatch(/^0x[0-9a-f]{40}$/);
      }
    }
    // the three deployment-era pools share one source and one Hasher
    const hashers = (["eth-1", "eth-10", "eth-100"] as const).map(
      (id) =>
        compareRuntime(readRecord(CONTRACTS[id].record), readRecord(CONTRACTS[id].record).runtimeBytecode.onchainBytecode).libraries[
          "TornadoCash_eth.sol:Hasher"
        ],
    );
    expect(new Set(hashers).size).toBe(1);
  });

  it("a byte changed outside the transformations is caught; a different library address at one site is caught", () => {
    const r = readRecord("pool-eth-1");
    const code = r.runtimeBytecode.onchainBytecode;
    const flipped = code.slice(0, 200) + (code[200] === "0" ? "1" : "0") + code.slice(201);
    const cmp = compareRuntime(r, flipped);
    expect(cmp.ok).toBe(false);
    expect(cmp.problems.join("; ")).toMatch(/not the one Sourcify verified/);
    expect(cmp.problems.join("; ")).toMatch(/beyond the transformations/);
    // the same bytes with the first Hasher link pointing elsewhere: the blanked comparison still passes, the link check fails
    const t = r.runtimeBytecode.transformations.find((x: { reason: string }) => x.reason === "library");
    const bytes = Buffer.from(code.slice(2), "hex");
    bytes.fill(0xab, t.offset, t.offset + 20);
    const relinked = compareRuntime(r, "0x" + bytes.toString("hex"));
    expect(relinked.problems.join("; ")).toMatch(/links to 2 different addresses/);
    const values = transformationValues("0x" + bytes.toString("hex"), r.runtimeBytecode.transformations, r.runtimeBytecode.cborAuxdata);
    expect(values.libraries["TornadoCash_eth.sol:Hasher"]).toHaveLength(2);
    expect(blankTransformations(code, r.runtimeBytecode.transformations, r.runtimeBytecode.cborAuxdata)).toBe(
      blankTransformations("0x" + bytes.toString("hex"), r.runtimeBytecode.transformations, r.runtimeBytecode.cborAuxdata),
    );
  });

  it("the standard JSON of a record carries its sources and its metadata's settings, never the compilation target", () => {
    const input = standardJsonOf(readRecord("pool-eth-1"));
    expect(input.language).toBe("Solidity");
    expect(Object.keys(input.sources)).toEqual(["TornadoCash_eth.sol"]);
    expect(input.settings).toMatchObject({ optimizer: { enabled: true, runs: 200 }, evmVersion: "petersburg" });
    expect(input.settings).not.toHaveProperty("compilationTarget");
    expect(input.settings.outputSelection["*"]["*"]).toEqual(["evm.deployedBytecode.object"]);
  });
});

describe("the ABI by hand", () => {
  it("computes the selectors the pools answer and encodes an address argument", () => {
    expect(selector("verifier()")).toBe("0x2b7ac3f3"); // cast sig "verifier()"
    expect(selector("transfer(address,uint256)")).toBe("0xa9059cbb");
    expect(selector("ROOT_HISTORY_SIZE()")).toMatch(/^0x[0-9a-f]{8}$/);
    expect(encodeAddress("0xD90E2F925da726B50c4ed8d0fb90AD053324f31b")).toBe("000000000000000000000000d90e2f925da726b50c4ed8d0fb90ad053324f31b");
    expect(callData("instances(address)", CONTRACTS["eth-1"].address)).toBe(selector("instances(address)") + encodeAddress(CONTRACTS["eth-1"].address));
    const w = words("0x" + "00".repeat(12) + "d90e2f925da726b50c4ed8d0fb90ad053324f31b" + "00".repeat(31) + "14");
    expect(w).toHaveLength(2);
    expect(wordAddress(w[0])).toBe("0xd90e2f925da726b50c4ed8d0fb90ad053324f31b");
    expect(wordNumber(w[1])).toBe(20);
  });
});

describe("the verifier's key", () => {
  it("parses alfa1, beta2, gamma2, delta2 and seven IC points (six public inputs) from Verifier.sol", () => {
    const vk = parseVerifyingKey(readRecord("verifier").sources["Verifier.sol"]);
    expect(vk.nPublic).toBe(6);
    expect(vk.IC).toHaveLength(7);
    for (const p of [vk.alfa1, ...vk.IC]) expect(p.every((x: string) => /^\d+$/.test(x))).toBe(true);
    for (const q of [vk.beta2, vk.gamma2, vk.delta2]) expect(q.flat().every((x: string) => /^\d+$/.test(x))).toBe(true);
    expect(() => parseVerifyingKey("contract Verifier {}")).toThrow(/vk\.alfa1/);
  });
});

describe("the pins (src/config/deployment.json)", () => {
  it("exist, name chain 1, and agree with the records: the addresses, the sizes and hashes of the code Sourcify saw, the deployed blocks", () => {
    expect(existsSync(PINS_FILE), "run scripts/verify-deployment.mjs --write").toBe(true);
    const pins = readPins()!;
    expect(pins.chainId).toBe(1);
    expect(pins.readAt.block).toBeGreaterThan(26_000_000);
    for (const id of POOLS) {
      const r = readRecord(CONTRACTS[id].record);
      const p = pins.pools[id];
      expect(p.address).toBe(CONTRACTS[id].address);
      expect(p.runtime.sha256).toBe(sha256Hex(r.runtimeBytecode.onchainBytecode));
      expect(p.runtime.bytes).toBe((r.runtimeBytecode.onchainBytecode.length - 2) / 2);
      expect(p.deployedBlock).toBe(Number(r.deployment.blockNumber));
      expect(p.verifier).toBe(CONTRACTS.verifier.address);
      expect(p.levels).toBe(20);
      expect(p.operator).toBe("0x0000000000000000000000000000000000000000");
      expect(p.rootHistorySize).toBe(100);
    }
    expect(pins.pools["eth-0.1"].denominationWei).toBe("100000000000000000");
    expect(pins.pools["eth-100"].denominationWei).toBe("100000000000000000000");
    expect(pins.verifier.vk.nPublic).toBe(6);
    expect(pins.router.instanceRegistry).toBe(CONTRACTS.instanceRegistry.address);
    expect(pins.router.relayerRegistry).toBe(CONTRACTS.relayerRegistry.address);
    for (const id of POOLS) expect(pins.instanceRegistry.instances[id].state).toBe(1);
    expect(Object.keys(pins.compilers).sort()).toEqual(Object.keys(COMPILERS).sort());
    // the drift check sees a changed pin
    const bent = JSON.parse(JSON.stringify(pins));
    bent.pools["eth-1"].rootHistorySize = 30;
    expect(diffPins(bent, pins)).toEqual(["eth-1.rootHistorySize: pinned 30, read 100"]);
    expect(diffPins(pins, pins)).toEqual([]);
  });
});

describe("a rebuild with the pinned compiler", () => {
  const cached = Object.keys(COMPILERS).filter((v) => compilerCached(v));
  it(
    cached.length
      ? `reproduces the chain's code for every record built with a cached compiler (${cached.join(", ")})`
      : "is skipped: no pinned compiler is cached on this machine (scripts/verify-deployment.mjs fetches them)",
    () => {
      for (const v of cached) {
        const compiler = loadCompiler(v);
        for (const c of Object.values(CONTRACTS)) {
          const r = readRecord(c.record);
          if (r.compilation.compilerVersion !== v) continue;
          const rebuilt = rebuildRecord(r, compiler);
          const cmp = compareRuntime(r, r.runtimeBytecode.onchainBytecode, rebuilt);
          expect(cmp.problems, c.record).toEqual([]);
          expect(cmp.matchesRebuilt, c.record).toBe(true);
        }
      }
    },
    600_000,
  );
});

/** The records directory exists beside this file's app (a guard for the paths above). */
it("the records live under classic/contracts/verified", () => {
  expect(existsSync(join(VERIFIED_DIR, "pool-eth-1.json"))).toBe(true);
});
