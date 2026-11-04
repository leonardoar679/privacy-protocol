// The zkAPI SDK pins (the sixth review round, 2026-11-03): the wallet bundles a sibling clone's sdk/ directory when one is
// present, and the build takes it only when every file hashes to apps/web/zkapi-sdk.pins.json and the clone's commit is the
// pinned one — a clone moved to another commit, an edited file, a missing or an extra file all refuse.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSdkPinned, bytesOf, compareSdkPins, hashSdk, headOf, PIN_FILE, readSdkPins, sdkPresent } from "../scripts/zkapi-sdk-pins-lib.mjs";

const dirs: string[] = [];
function clone(): string {
  const dir = mkdtempSync(join(tmpdir(), "zkapi-sdk-"));
  dirs.push(dir);
  mkdirSync(join(dir, "sdk", "services"), { recursive: true });
  mkdirSync(join(dir, "sdk", "test"), { recursive: true });
  mkdirSync(join(dir, "sdk", "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, "sdk", "index.js"), "export const a = 1;\n");
  writeFileSync(join(dir, "sdk", "services", "client.js"), "export const b = 2;\n");
  writeFileSync(join(dir, "sdk", "test", "client.test.js"), "test\n");
  writeFileSync(join(dir, "sdk", "node_modules", "x", "index.js"), "dep\n");
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the zkAPI SDK pins", () => {
  it("hashes every file under sdk/ but the tests and node_modules, in a fixed order", () => {
    const dir = clone();
    const files = hashSdk(dir);
    expect(Object.keys(files)).toEqual(["sdk/index.js", "sdk/services/client.js"]);
    expect(files["sdk/index.js"]).toMatch(/^[0-9a-f]{64}$/);
    expect(bytesOf(dir, files)).toBe(20 + 20);
    expect(sdkPresent(dir)).toBe(true);
    expect(sdkPresent(join(dir, "nowhere"))).toBe(false);
    expect(headOf(dir), "not a git checkout").toBeNull();
  });
  it("compareSdkPins: the pinned clone passes; an edited, a missing and an extra file, and another commit, each refuse", () => {
    const dir = clone();
    const pins = { commit: "abc", files: hashSdk(dir) };
    expect(compareSdkPins(pins, dir)).toEqual([]);
    writeFileSync(join(dir, "sdk", "index.js"), "export const a = 2;\n");
    expect(compareSdkPins(pins, dir)).toEqual([expect.stringMatching(/^sdk\/index\.js: hashes to [0-9a-f]{16}…, pinned [0-9a-f]{16}…$/)]);
    rmSync(join(dir, "sdk", "index.js"));
    expect(compareSdkPins(pins, dir)).toEqual(["sdk/index.js: pinned, not in the clone"]);
    writeFileSync(join(dir, "sdk", "index.js"), "export const a = 1;\n");
    writeFileSync(join(dir, "sdk", "extra.js"), "extra\n");
    expect(compareSdkPins(pins, dir)).toEqual(["sdk/extra.js: in the clone, not pinned"]);
    expect(compareSdkPins(null, dir)[0]).toMatch(/missing or unreadable/);
    expect(compareSdkPins({ files: "x" }, dir)[0]).toMatch(/missing or unreadable/);
    expect(readSdkPins(join(dir, "none.json"))).toBeNull();
  });
  it("assertSdkPinned throws for a clone that is not the pinned one; the committed pin file names a commit and files", () => {
    const dir = clone();
    expect(() => assertSdkPinned(dir)).toThrow(/is not the pinned one/);
    const pins = readSdkPins(PIN_FILE);
    expect(pins?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(pins?.files ?? {}).length).toBeGreaterThan(10);
    for (const [path, hash] of Object.entries(pins?.files ?? {})) {
      expect(path).toMatch(/^sdk\//);
      expect(path).not.toMatch(/^sdk\/(test|node_modules)\//);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
