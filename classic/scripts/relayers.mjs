// The curated relayer list (spec v3.0 §7.5; V7 Stage 8): every RelayerRegistered event of the registry, the newest
// registration per ENS name, each name's owner and `mainnet-tornado` host record from ENS, its registration and stake
// from the registry, the original UI's rules over them (the owner is the registered address, a host without a scheme,
// registered, at least 40 TORN), then GET /v1/status of every qualified host and the protocol's rules over the answer
// (healthy, mainnet, all four ETH pools at the pinned addresses, the reward account the registry knows, a fee under the
// cap, a queue of at most five, a trusted version). The ones that pass are written to classic/relayers.json — the list
// the app offers and the content security policy allows — with a survey of the rest. Runs the app's own modules under
// Node's type stripping, like the snapshot generator.
//   node scripts/relayers.mjs [--out relayers.json] [--rpc <url,…>] [--log-rpc <url,…>] [--timeout 15000] [--concurrency 2] [--min-stake 40]
// (a burst of parallel TLS connections stalled on the development workstation: the status requests run two at a time)
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRpc, PUBLIC_LOG_RPC_URLS, PUBLIC_RPC_URLS, readPins } from "./deployment.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, "..");
const src = (p) => new URL(`../src/${p}`, import.meta.url).href;
const { fetchRegistrations, latestByName, readRelayerRecord, registryProblems, readMinStake, RELAYER_REGISTRY } = await import(src("relayer/registry.ts"));
const { checkRelayer } = await import(src("relayer/rules.ts"));
const { statusOf } = await import(src("relayer/client.ts"));
const { relayerTransport } = await import(src("net/relayer.ts"));
const { headBlockOf } = await import(src("history/sync.ts"));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const list = (s) =>
  String(s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const torn = (wei) => (Number(wei / 10n ** 15n) / 1000).toFixed(3);

/** Runs `fn` over `items` with at most `n` in flight. */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

export async function discover({
  rpcUrls = PUBLIC_RPC_URLS,
  logRpcUrls = PUBLIC_LOG_RPC_URLS,
  timeoutMs = 15_000,
  concurrency = 2,
  minStakeTorn = 40,
  log = console.log,
} = {}) {
  const pins = readPins();
  if (!pins) throw new Error("src/config/deployment.json is missing (scripts/verify-deployment.mjs --write)");
  const pools = Object.entries(pins.pools).map(([id, p]) => ({ id, address: p.address.toLowerCase(), amount: p.amount }));
  const rpc = makeRpc(rpcUrls);
  const logRpc = makeRpc(logRpcUrls);
  const block = await headBlockOf(rpc);
  const minStakeWei = await readMinStake(rpc);
  const registrations = await fetchRegistrations(logRpc, block);
  const names = latestByName(registrations);
  log(`registry ${RELAYER_REGISTRY}: ${registrations.length} registrations, ${names.length} names, minimum stake ${torn(minStakeWei)} TORN (block ${block})`);

  const records = await mapLimit(names, concurrency, async (r) => {
    try {
      const record = await readRelayerRecord(rpc, r.ensName, r.relayerAddress);
      return { registration: r, record, problems: registryProblems(record, { minStakeWei: BigInt(minStakeTorn) * 10n ** 18n }) };
    } catch (e) {
      return { registration: r, record: null, problems: [`read failed: ${e instanceof Error ? e.message : String(e)}`] };
    }
  });
  // a host without a public suffix names nothing (the sixth review round, 2026-11-03): the registry carries garbage like "livetobecomeavillain"
  const qualified = records.filter((x) => x.record && x.problems.length === 0 && /\.[a-z0-9-]+$/i.test(String(x.record.host)));
  const byProblem = {};
  for (const x of records) for (const p of x.problems) byProblem[p] = (byProblem[p] ?? 0) + 1;
  log(`records: ${qualified.length} qualify by the registry rules; the rest: ${JSON.stringify(byProblem)}`);

  const transport = relayerTransport({ timeoutMs });
  const checked = await mapLimit(qualified, concurrency, async (x) => {
    const url = `https://${x.record.host}`;
    try {
      const status = await statusOf(transport, url);
      const verdicts = pools.map((pool) => checkRelayer({ status, netId: pins.chainId ?? 1, pool, expectedRewardAccount: x.record.relayerAddress }));
      const problems = [...new Set(verdicts.flatMap((v) => (v.ok ? [] : v.problems)))];
      const facts = verdicts[0].facts;
      return { ...x, url, status, facts, problems: problems.length ? problems : null };
    } catch (e) {
      return { ...x, url, status: null, facts: null, problems: [`offline: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`] };
    }
  });
  const online = checked.filter((x) => x.status && !x.problems);
  const offline = checked.filter((x) => !x.status || x.problems).map((x) => ({ ensName: x.registration.ensName, url: x.url, problems: x.problems }));
  log(`status: ${online.length} online and within the rules, ${offline.length} not listed`);
  for (const o of offline) log(`  not listed: ${o.ensName} ${o.url} — ${o.problems.join("; ")}`);

  const relayers = online
    .map((x) => ({
      ensName: x.registration.ensName,
      relayerAddress: x.record.relayerAddress,
      url: x.url,
      rewardAccount: x.facts.rewardAccount,
      stakeTorn: torn(x.record.balanceWei),
      feePercent: x.status.tornadoServiceFee,
      version: x.status.version,
      currentQueue: x.facts.currentQueue,
    }))
    .sort((a, b) => a.feePercent - b.feePercent || Number(b.stakeTorn) - Number(a.stakeTorn) || a.ensName.localeCompare(b.ensName));
  return {
    comment:
      "The relayers the Classic app offers (spec v3.0 §7.5): written by classic/scripts/relayers.mjs from the on-chain registry (every RelayerRegistered event, the newest per ENS name), each name's owner and mainnet-tornado url record from ENS, its registration and stake, the original interface's rules over them, and GET /v1/status of every qualified host held to the protocol's rules (healthy, mainnet, the four ETH pools at the pinned addresses, the reward account the registry registered, a fee under the cap, a queue of at most five, tornado-relayer 4.1.4+ or 5.x). Sorted by fee, then stake. The app reads each relayer's status again when a withdrawal is prepared; this list says who may be asked, and the build's content security policy allows exactly these hosts. Regenerate before a release: npm run relayers.",
    generatedAt: new Date().toISOString(),
    block,
    registry: { address: RELAYER_REGISTRY, minStakeTorn: torn(minStakeWei), registrations: registrations.length, names: names.length },
    relayers,
    survey: { qualifiedByRegistry: qualified.length, online: online.length, registryProblems: byProblem, notListed: offline },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await discover({
      rpcUrls: list(arg("rpc", null)).length ? list(arg("rpc", null)) : PUBLIC_RPC_URLS,
      logRpcUrls: list(arg("log-rpc", null)).length ? list(arg("log-rpc", null)) : PUBLIC_LOG_RPC_URLS,
      timeoutMs: Number(arg("timeout", 15_000)),
      concurrency: Number(arg("concurrency", 2)),
      minStakeTorn: Number(arg("min-stake", 40)),
    });
    const out = resolve(arg("out", join(APP, "relayers.json")));
    writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
    console.log(`written: ${out} — ${result.relayers.length} relayers`);
    for (const r of result.relayers)
      console.log(`  ${r.ensName.padEnd(28)} ${r.url.padEnd(40)} fee ${r.feePercent} %  stake ${r.stakeTorn} TORN  v${r.version}`);
  } catch (e) {
    console.error(`FAIL  ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
