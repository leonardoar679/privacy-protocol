// The history snapshot generator (spec v3.0 §7.4; V7 Stage 7): per pool, every Deposit and Withdrawal event from the
// deployed block to a recent block, the tree's layers and a manifest, written under public/data/<pool>/ (git-ignored:
// a deploy-time artifact served at /classic/data/). Seeded from the original UI's event caches (the classic-ui clone
// beside the repository, to June 2022), then the delta through eth_getLogs in windows sized to the endpoint, and held
// to the chain before it is written: the leaf count is nextIndex(), the root is a root the pool knows; with --archive,
// getLastRoot() at the snapshot's own block. Runs the app's own modules (src/history, src/crypto) under Node's type
// stripping, so the generator and the app share one implementation.
//   node scripts/snapshot.mjs --pool eth-100 [--to latest|<block>] [--rpc <url,…>] [--log-rpc <url,…>] [--archive <url>]
//                             [--seed auto|classic-ui|none] [--out <dir>] [--window 500000] [--fixture <n>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRpc, PUBLIC_LOG_RPC_URLS, PUBLIC_RPC_URLS, readPins } from "./deployment.mjs";
import { readZip } from "./zip.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, "..");
const src = (p) => new URL(`../src/${p}`, import.meta.url).href;
const { buildSnapshot } = await import(src("history/snapshotTree.ts"));
const { syncDelta, blockHashOf, headBlockOf, CONFIRMATIONS } = await import(src("history/sync.ts"));
const { verifyAgainstChain, call, SELECTORS } = await import(src("history/verify.ts"));
const { checkContinuity } = await import(src("history/events.ts"));

export const CLASSIC_UI_EVENTS = join(APP, "..", "..", "tornado-classic-ui", "static", "events");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const list = (s) =>
  String(s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const toHex32 = (x) => "0x" + BigInt(x).toString(16).padStart(64, "0");

/** The original UI's caches for a pool: deposits (ascending by leaf) and withdrawals (ascending by block), as events. */
export function seedFromClassicUi(amount, dir = CLASSIC_UI_EVENTS) {
  const depositsZip = join(dir, `deposits_eth_${amount}.json.zip`);
  const withdrawalsZip = join(dir, `withdrawals_eth_${amount}.json.zip`);
  if (!existsSync(depositsZip) || !existsSync(withdrawalsZip)) return null;
  const read = (zip) => {
    const files = readZip(readFileSync(zip));
    const [first] = files.values();
    return JSON.parse(first.toString("utf8"));
  };
  const deposits = read(depositsZip)
    .map((d) => ({
      leafIndex: d.leafIndex,
      commitment: d.commitment.toLowerCase(),
      timestamp: Number(d.timestamp),
      blockNumber: d.blockNumber,
      transactionHash: d.transactionHash.toLowerCase(),
    }))
    .sort((a, b) => a.leafIndex - b.leafIndex);
  checkContinuity(deposits, 0);
  const withdrawals = read(withdrawalsZip)
    .map((w) => ({
      nullifierHash: w.nullifierHash.toLowerCase(),
      to: w.to.toLowerCase(),
      relayer: null,
      fee: String(w.fee),
      blockNumber: w.blockNumber,
      transactionHash: w.transactionHash.toLowerCase(),
    }))
    .sort((a, b) => a.blockNumber - b.blockNumber);
  const toBlock = deposits.at(-1).blockNumber;
  return {
    deposits,
    withdrawals: withdrawals.filter((w) => w.blockNumber <= toBlock),
    toBlock,
    source: `classic-ui static/events/{deposits,withdrawals}_eth_${amount}.json.zip`,
  };
}

export async function generate({
  pool,
  to = "latest",
  rpcUrls = PUBLIC_RPC_URLS,
  logRpcUrls = PUBLIC_LOG_RPC_URLS,
  archiveUrl = null,
  seed = "auto",
  out = join(APP, "public", "data"),
  window = 500_000,
  fixture = null,
  log = console.log,
}) {
  const pins = readPins();
  const p = pins?.pools?.[pool];
  if (!p) throw new Error(`${pool} is not a pinned pool (src/config/deployment.json)`);
  const address = p.address.toLowerCase();
  const rpc = makeRpc(rpcUrls);
  const logRpc = makeRpc(logRpcUrls);
  const seeded = seed === "none" ? null : seedFromClassicUi(p.amount);
  if (seed === "classic-ui" && !seeded) throw new Error(`no classic-ui caches under ${CLASSIC_UI_EVENTS}`);
  let deposits = seeded?.deposits ?? [];
  let withdrawals = seeded?.withdrawals ?? [];
  let fromBlock = seeded ? seeded.toBlock : p.deployedBlock - 1;
  log(
    seeded
      ? `seed: ${deposits.length} deposits and ${withdrawals.length} withdrawals to block ${seeded.toBlock} (${seeded.source})`
      : `no seed: syncing from the deployed block ${p.deployedBlock}`,
  );

  let toBlock;
  let blockHash;
  if (fixture) {
    // the first `fixture` leaves of the seed, ending at the block of the last one (no later deposit may share that block)
    const n = Number(fixture);
    if (!seeded || deposits.length <= n) throw new Error(`the seed has no ${n + 1} deposits to cut a fixture from`);
    if (deposits[n].blockNumber === deposits[n - 1].blockNumber) throw new Error(`deposit ${n} shares the block of deposit ${n - 1}: cut elsewhere`);
    deposits = deposits.slice(0, n);
    toBlock = deposits.at(-1).blockNumber;
    withdrawals = withdrawals.filter((w) => w.blockNumber <= toBlock);
    blockHash = await blockHashOf(rpc, toBlock);
  } else {
    const head = to === "latest" ? await headBlockOf(rpc) : Number(to);
    const target = to === "latest" ? head - CONFIRMATIONS : head;
    const t0 = Date.now();
    const delta = await syncDelta({
      rpc: logRpc,
      address,
      fromBlock,
      leaves: deposits.length,
      headBlock: target + CONFIRMATIONS,
      window,
      onWindow: (w) => log(`  blocks ${w.from}–${w.to}: ${w.deposits} deposits, ${w.withdrawals} withdrawals (window ${w.window})`),
    });
    deposits = [...deposits, ...delta.deposits];
    withdrawals = [...withdrawals, ...delta.withdrawals];
    toBlock = delta.toBlock;
    blockHash = delta.blockHash ?? (await blockHashOf(rpc, toBlock));
    log(
      `delta: ${delta.deposits.length} deposits and ${delta.withdrawals.length} withdrawals in ${delta.windows} windows, ${Math.round((Date.now() - t0) / 1000)} s; to block ${toBlock}`,
    );
  }

  const t1 = Date.now();
  const built = await buildSnapshot({
    pool,
    address,
    chainId: pins.chainId ?? 1,
    deployedBlock: p.deployedBlock,
    toBlock,
    blockHash,
    deposits,
    withdrawals,
    generatedAt: new Date().toISOString(),
  });
  log(`tree: ${built.tree.size} leaves, root ${built.manifest.root}, hashed in ${Math.round((Date.now() - t1) / 1000)} s`);

  // held to the chain
  const verified = {};
  if (archiveUrl) {
    const archive = makeRpc([archiveUrl]);
    const rootAt = toHex32(BigInt(await call(archive, address, SELECTORS.getLastRoot, "0x" + toBlock.toString(16))));
    if (rootAt !== built.manifest.root) throw new Error(`the pool's root at block ${toBlock} is ${rootAt}, the snapshot's ${built.manifest.root}: refused`);
    verified.method = `eth_call getLastRoot() at block ${toBlock}`;
    verified.endpoint = archiveUrl;
    verified.block = toBlock;
    log(`archive: getLastRoot() at block ${toBlock} equals the snapshot's root`);
  }
  if (!fixture) {
    const chain = await verifyAgainstChain(rpc, address, built.tree);
    if (!chain.ok)
      throw new Error(
        `the chain disagrees (${chain.reason}): nextIndex ${chain.nextIndex} vs ${chain.leaves} leaves, root known ${chain.known}, last root ${chain.lastRoot}: refused`,
      );
    verified.method = verified.method ? `${verified.method}; isKnownRoot and nextIndex at latest` : "isKnownRoot and nextIndex at latest";
    log(`chain: nextIndex ${chain.nextIndex} == leaves, the root ${chain.known ? "known" : "the last root"}`);
  }
  built.manifest.verified = { ...verified, date: new Date().toISOString().slice(0, 10) };

  const dir = join(out, pool);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(built.texts)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(built.manifest, null, 2) + "\n");
  log(
    `written: ${dir} (${Object.values(built.texts)
      .reduce((n, t) => n + Buffer.byteLength(t), 0)
      .toLocaleString()} bytes in three files + manifest.json)`,
  );
  return built.manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = arg("pool", null);
  if (!pool) {
    console.error(
      "usage: node scripts/snapshot.mjs --pool eth-100 [--to latest|<block>] [--rpc <url,…>] [--log-rpc <url,…>] [--archive <url>] [--seed auto|classic-ui|none] [--out <dir>] [--window <blocks>] [--fixture <n>]",
    );
    process.exit(2);
  }
  try {
    await generate({
      pool,
      to: arg("to", "latest"),
      rpcUrls: list(arg("rpc", null)).length ? list(arg("rpc", null)) : PUBLIC_RPC_URLS,
      logRpcUrls: list(arg("log-rpc", null)).length ? list(arg("log-rpc", null)) : PUBLIC_LOG_RPC_URLS,
      archiveUrl: arg("archive", null),
      seed: arg("seed", "auto"),
      out: arg("out", null) ? resolve(arg("out", null)) : join(APP, "public", "data"),
      window: Number(arg("window", 500_000)),
      fixture: arg("fixture", null),
    });
  } catch (e) {
    console.error(`FAIL  ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
