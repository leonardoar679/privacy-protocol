// The relayers against Ethereum mainnet and the relayers themselves (spec v3.0 §7.5; V7 Stage 8; verify-all --live): the
// registry's facts (its minimum stake, its router, the registrations), one relayer's ENS record read as the discovery
// does, and the curated list — every relayer asked for its status and held to the protocol's rules for all four pools;
// the list is stale when none answers (regenerate it: npm run relayers).
import { describe, expect, it } from "vitest";
import { makeRpc, PUBLIC_LOG_RPC_URLS, PUBLIC_RPC_URLS, readPins } from "../../scripts/deployment.mjs";
import { statusOf } from "../../src/relayer/client";
import { CURATED_RELAYERS } from "../../src/relayer/curated";
import { fetchRegistrations, latestByName, readMinStake, readRelayerRecord, registryProblems } from "../../src/relayer/registry";
import { checkRelayer } from "../../src/relayer/rules";
import { headBlockOf } from "../../src/history/sync";
import { relayerTransport } from "../../src/net/relayer";

const list = (env: string | undefined, fallback: readonly string[]) =>
  (env ?? fallback.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const rpc = makeRpc(list(process.env.CLASSIC_RPC_URLS, PUBLIC_RPC_URLS));
const logRpc = makeRpc(list(process.env.CLASSIC_LOG_RPC_URLS, PUBLIC_LOG_RPC_URLS));
const pins = readPins() as { chainId: number; pools: Record<string, { address: string; amount: string }> };
const pools = Object.values(pins.pools).map((p) => ({ address: p.address.toLowerCase(), amount: p.amount }));

describe("the relayer registry on mainnet", () => {
  it("asks 5,000 TORN of a new relayer today, holds at least the 127 registrations of 2022–2026, and resolves a curated relayer's host as the discovery does", async () => {
    const minStake = await readMinStake(rpc);
    expect(minStake).toBe(5000n * 10n ** 18n);
    const head = await headBlockOf(rpc);
    const registrations = await fetchRegistrations(logRpc, head);
    expect(registrations.length).toBeGreaterThanOrEqual(127);
    const names = latestByName(registrations);
    expect(names.length).toBeGreaterThanOrEqual(123);
    const first = CURATED_RELAYERS[0];
    const registration = names.find((n) => n.ensName === first.ensName);
    expect(registration, `${first.ensName} registered`).toBeDefined();
    const record = await readRelayerRecord(rpc, first.ensName, registration!.relayerAddress);
    expect(record.owner).toBe(first.relayerAddress.toLowerCase());
    expect(`https://${record.host}`).toBe(first.url);
    expect(record.registered).toBe(true);
    expect(registryProblems(record)).toEqual([]);
    console.info(
      `REGISTRY  ${registrations.length} registrations, ${names.length} names, minimum stake ${Number(minStake / 10n ** 18n)} TORN; ${first.ensName} → ${record.host}, ${Number(record.balanceWei / 10n ** 18n)} TORN`,
    );
  }, 180_000);
});

describe("the curated relayers", () => {
  it("answer their status and pass the rules for every ETH pool (those that do not are named); at least one is online", async () => {
    const transport = relayerTransport({ timeoutMs: 15_000 });
    // one at a time: on this workstation a burst of parallel TLS connections stalls (the discovery learnt the same)
    const results: { name: string; online: boolean; detail: string }[] = [];
    for (const r of CURATED_RELAYERS) {
      try {
        const status = await statusOf(transport, r.url);
        const problems = [
          ...new Set(
            pools.flatMap((pool) => {
              const v = checkRelayer({ status, netId: pins.chainId, pool, expectedRewardAccount: r.relayerAddress });
              return v.ok ? [] : v.problems;
            }),
          ),
        ];
        results.push({
          name: r.ensName,
          online: problems.length === 0,
          detail: problems.length ? problems.join(", ") : `v${status.version} fee ${status.tornadoServiceFee} % queue ${status.currentQueue ?? 0}`,
        });
      } catch (e) {
        results.push({ name: r.ensName, online: false, detail: `offline: ${e instanceof Error ? e.message.slice(0, 60) : String(e)}` });
      }
    }
    const online = results.filter((r) => r.online);
    console.info(
      `RELAYERS  ${online.length}/${results.length} of the curated list online and within the rules${
        results.length - online.length
          ? `; not now: ${results
              .filter((r) => !r.online)
              .map((r) => `${r.name} (${r.detail})`)
              .join(", ")}`
          : ""
      }`,
    );
    expect(CURATED_RELAYERS.length).toBeGreaterThan(0);
    expect(online.length, "the curated list is stale: npm run relayers").toBeGreaterThan(0);
  }, 600_000);
});
