// Quote the live providers for a route and show the engine's choice per policy, the one-time
// endpoint and the privacy score — no funds move. Usage:
//   npx tsx src/cli.ts [amountEth=1] [to=BTC|SOL|USDC_BASE] [policy=best-privacy]
import { randomBytes } from "crypto";
import { userStatus } from "./order";
import { defaultEngine } from "./config";
import type { AssetRef, Policy, QuoteRequest } from "./types";

const [amountEth = "1", toSym = "BTC", policyArg = "best-privacy"] = process.argv.slice(2);
const policy = policyArg as Policy;
const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const TO: Record<string, { ref: AssetRef; dest: string }> = {
  BTC: { ref: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, dest: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh" },
  SOL: { ref: { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" }, dest: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
  USDC_BASE: { ref: { chain: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" }, dest: "0x000000000000000000000000000000000000dEaD" },
};
const target = TO[toSym] ?? TO.BTC;
const engine = defaultEngine();
const req: QuoteRequest = { from: ETH, to: target.ref, amount: BigInt(Math.round(Number(amountEth) * 1e6)) * 10n ** 12n, destination: target.dest, slippageBps: 50 };

const fmt = (x: bigint, d: number) => (Number(x) / 10 ** d).toFixed(Math.min(d, 8));
const set = await engine.quoteAll(req, policy);
console.log(`\n${amountEth} ETH -> ${target.ref.symbol} (${target.ref.chain}), policy ${policy}\n`);
for (const s of set.scores) {
  const q = set.quotes.find((x) => x.provider === s.provider)!;
  console.log(`${s.provider.padEnd(14)} out ${fmt(q.toAmount, target.ref.decimals)} min ${fmt(q.toAmountMin, target.ref.decimals)} ${target.ref.symbol}  eta ${q.etaSeconds}s  native ${q.nativeAssets}  ` +
    `score ${s.total}  [price ${s.components.price} sec ${s.components.security} priv ${s.components.privacy} lat ${s.components.latency} rel ${s.components.reliability}]${s.filtered ? "  FILTERED: " + s.filtered : ""}`);
}
for (const [id, err] of Object.entries(set.errors)) console.log(`${id.padEnd(14)} ${err}`);
if (set.chosen) {
  const quote = set.quotes.find((q) => q.provider === set.chosen!.provider)!;
  const key = randomBytes(32);
  const order = engine.buildOrder(req, policy, quote, { orderPrivateKey: key, refundOwnerCommitment: 1n, refundNoteSecret: 2n, refundNoteDataHash: ("0x" + "00".repeat(32)) as `0x${string}` });
  console.log(`\nchosen ${set.chosen.provider}; one-time endpoint ${order.endpoint}; delay budget ${order.privacy.delaySeconds.map((s) => s / 3600).join("–")} h; privacy score ${order.privacy.score}; status ${userStatus(order.state)}`);
  const adapter = engine.cfg.adapters.find((a) => a.id === set.chosen!.provider)!;
  const x = await engine.authorize(order, adapter, key);
  console.log(`signed execution: provider ${x.provider}, value ${fmt(x.value, 18)} ETH, calldata ${x.providerCalldata.length / 2 - 1} bytes, deadline ${new Date(x.deadline * 1000).toISOString()}, sig ${x.signature.slice(0, 18)}…`);
  if (order.ingress.memo) console.log(`memo ${order.ingress.memo}`);
}
process.exit(0);
