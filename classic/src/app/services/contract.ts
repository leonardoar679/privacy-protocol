// The pool and the router right now (spec v3.0 §7.7): the pool's runtime code hashed against the pin the verification
// wrote, its verifier, levels and denomination read, and the router's registry asked whether the instance is enabled.
// Pure over the JSON-RPC function.
import { sha256Hex } from "../../crypto/digest";
import { keccak256 } from "js-sha3";
import type { Rpc } from "../../history/sync";
import { call, wordOf } from "../../history/verify";
import type { Pool } from "../../model/pools";

const selector = (s: string) => "0x" + keccak256(s).slice(0, 8);
const SEL = Object.freeze({
  verifier: selector("verifier()"),
  levels: selector("levels()"),
  denomination: selector("denomination()"),
  instances: selector("instances(address)"),
});

export interface ContractPins {
  runtimeSha256: string;
  verifier: string;
  levels: number;
  denominationWei: string;
}

export type ContractCheck = { ok: true } | { ok: false; problems: string[] };

/** The pool as deployed, against the pins: its code (the sha256 of the hex the endpoint returns, as the verification hashed it), its verifier, levels and denomination. */
export async function checkPoolContract(rpc: Rpc, pool: Pool, pins: ContractPins): Promise<ContractCheck> {
  const problems: string[] = [];
  const code = (await rpc("eth_getCode", [pool.address, "latest"])) as string;
  if (typeof code !== "string" || code.length <= 2) problems.push("no code at the pool's address");
  else if ((await sha256Hex(new TextEncoder().encode(code.toLowerCase()))) !== pins.runtimeSha256) problems.push("the pool's code is not the pinned one");
  const [verifier, levels, denomination] = await Promise.all([
    call(rpc, pool.address, SEL.verifier).then((o) => `0x${wordOf(o).toString(16).padStart(40, "0")}`),
    call(rpc, pool.address, SEL.levels).then((o) => Number(wordOf(o))),
    call(rpc, pool.address, SEL.denomination).then((o) => wordOf(o)),
  ]);
  if (verifier !== pins.verifier.toLowerCase()) problems.push("the pool's verifier is not the pinned one");
  if (levels !== pins.levels) problems.push(`the pool has ${levels} levels, not ${pins.levels}`);
  if (denomination !== BigInt(pins.denominationWei)) problems.push("the pool's denomination is not the pinned one");
  return problems.length ? { ok: false, problems } : { ok: true };
}

export type InstanceState = "enabled" | "disabled";

/** InstanceRegistry.instances(pool): DISABLED (0), ENABLED (1), MINEABLE (2) — the last two take deposits through the router. */
export async function routerInstanceState(rpc: Rpc, instanceRegistry: `0x${string}`, pool: `0x${string}`): Promise<InstanceState> {
  const out = await call(rpc, instanceRegistry, SEL.instances + pool.slice(2).toLowerCase().padStart(64, "0"));
  const hex = out.slice(2);
  if (hex.length < 64 * 3) throw new Error("the registry answered too little");
  const state = Number(BigInt("0x" + hex.slice(128, 192)));
  return state === 0 ? "disabled" : "enabled";
}
