#!/usr/bin/env node
// Emits the zkAPI browser SDK's public assets for one network into public/zkapi (browser-config.json
// with the pinned deployment, the proof worker, the WASM wallet, both proving keys, sdk-assets.json)
// so the wallet's Private AI tab can load them same-origin. The helper verifies every source
// artifact hash and both proving-key pins before writing. No credentials, no network, no Rust.
// Usage: ZKAPI_NETWORK=sepolia|mainnet node scripts/build-zkapi-assets.mjs   (default: sepolia)
import { build } from "esbuild";
import { buildBrowserSdkAssets } from "@openanonymity/zkapi-browser-sdk/build";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const network = process.env.ZKAPI_NETWORK ?? "sepolia";
const outDir = join(here, "..", "public", "zkapi");
const result = await buildBrowserSdkAssets({ outDir, publicPath: "/zkapi/", network, build });
console.log(JSON.stringify({ network, outDir, result }, null, 2));
