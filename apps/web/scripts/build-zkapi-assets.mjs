#!/usr/bin/env node
// Emits the zkAPI browser SDK's public assets for one network into public/zkapi (browser-config.json
// with the pinned deployment, the proof worker, the WASM wallet, both proving keys, sdk-assets.json)
// so the wallet's Private AI tab can load them same-origin. The helper verifies every source
// artifact hash and both proving-key pins before writing. No credentials, no network, no Rust.
// Usage: ZKAPI_NETWORK=sepolia|mainnet node scripts/build-zkapi-assets.mjs   (default: sepolia)
// The SDK is the clone ZKAPI_SDK_DIR names (default: the clone beside this repository; V6 Stage 2), not an npm dependency.
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSdkPinned } from "./zkapi-sdk-pins-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sdkDir = process.env.ZKAPI_SDK_DIR ?? resolve(here, "../../../../zkapi");
if (!existsSync(join(sdkDir, "sdk", "build.mjs"))) { console.error(`no zkAPI SDK at ${sdkDir} — clone it there or set ZKAPI_SDK_DIR (docs/private-ai.md)`); process.exit(2); }
assertSdkPinned(sdkDir); // the clone's files against the pins before its build script runs here (the sixth review round, 2026-11-03)
const { buildBrowserSdkAssets } = await import(pathToFileURL(join(sdkDir, "sdk", "build.mjs")).href);
const network = process.env.ZKAPI_NETWORK ?? "sepolia";
const outDir = join(here, "..", "public", "zkapi");
const result = await buildBrowserSdkAssets({ outDir, publicPath: "/zkapi/", network, build });
console.log(JSON.stringify({ network, outDir, result }, null, 2));
