// Protect (spec v2.0 §7.3, §7.6–§7.7; doc §19, §22–§23, §58): the connected wallet pays a public deposit into the
// protected balance through ProtectRouter (the 1 % privacy fee is the contract's), on the V6 screens — /protect the one
// page (ProtectView), /protect/review the Review (ReviewView: a tap below $50K, a hold from it, the recovery-information
// card once per session), /protect/progress/:opId the progress lines (ProgressView), then what was added or the verdict.
// One container serves the three routes, so the flow's state survives the navigation between them; a reload of the
// progress route reads the journaled operation. The §23 flow is ./model.ts (pure); the engine is sdk/privateTx.ts
// (shieldNative / shieldERC20: an ERC-20 asks the wallet to approve the router for exactly the amount, then to protect —
// two prompts, one operation). A failed ERC-20 deposit may leave its approval behind: it is read and can be revoked.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { formatUnits } from "viem";
import { bucketsFor } from "@privacy-wallet/protocol/wallet/amounts";
import { availablePrice, type Tier } from "@privacy-wallet/protocol/wallet/valuation";
import { AssetSelector, Button, Card, Collapsible, Page, SecurityCard, SuccessCard, TextButton, type AssetOption } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { readAllowance, revokeAllowance } from "@privacy-wallet/sdk/allowances";
import { assetsOf, formatAmount, parseAmount, type Asset } from "@privacy-wallet/sdk/assets";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { activeProvider } from "@privacy-wallet/wallet-engine/injected";
import { protectNet, shieldERC20, shieldNative } from "@privacy-wallet/sdk/privateTx";
import { feedsConfigured, priceStore } from "@privacy-wallet/sdk/prices";
import { controlsFor, holdMs } from "@privacy-wallet/sdk/tiers";
import { applyEvent, newOperation } from "@privacy-wallet/sdk/operations/store";
import { engineListener } from "@privacy-wallet/sdk/operations/engineEvents";
import { classify } from "@privacy-wallet/sdk/operations/errors/catalog";
import { OperationProgress } from "../operations/OperationProgress";
import { ProgressView } from "../progress/View";
import { furthestLine, progressModelOf } from "../progress/model";
import { ReviewView, type ReviewModel } from "../review/View";
import { amountFrom, amountOf, centsOf, displayAmount } from "../amounts";
import { ProtectView } from "./View";
import { protectModel } from "./model";
import { estimateShieldCost, type NetworkEstimate } from "./estimate";
import { readPublicBalance } from "./publicBalance";
import { useConnectivity, useOperation, usePrefs, usePrices, useSettings } from "../../hooks";

export interface ProtectScreenProps {
  masterSeed: Uint8Array;
  deployment: Deployment | null;
  /** the connected external wallet's account, if any */
  account: string | null;
  connecting?: boolean;
  onConnect?: () => void;
  /** the external wallet is on another network than the deployment's (a V6 follow-up of 2026-10-16): not taken as connected */
  wrongNetwork?: boolean;
  onSwitch?: () => void;
  onBack?: () => void;
  onDone?: () => void;
  /** More → Security, for the recovery-information card */
  onBackup?: () => void;
}

let nudgeDismissed = false; // the recovery-information card: once per session (spec v2.0 §7.2)

/** The common sizes offered under Advanced: the alphabet's buckets around one whole unit of the asset. */
export function chipBuckets(decimals: number): bigint[] {
  const unit = 10n ** BigInt(decimals);
  const lo = decimals >= 8 ? unit / 10n : unit * 100n;
  const hi = lo * 100n;
  return bucketsFor(decimals)
    .filter((b) => b >= lo && b <= hi)
    .slice(0, 6);
}

export function ProtectScreen(p: ProtectScreenProps) {
  const t = useT();
  const navigate = useNavigate();
  const { advanced } = useSettings();
  const net = useConnectivity(); // V6 Stage 15 (doc §75): no Confirm while offline
  const prices = usePrices();
  const pf = usePrefs();
  const assets = useMemo(() => assetsOf(p.deployment), [p.deployment]);
  const [asset, setAsset] = useState<Asset | undefined>(assets[0]);
  const [amount, setAmount] = useState("");
  const [picking, setPicking] = useState(false);
  const [publicBalance, setPublicBalance] = useState<bigint | null>(null);
  const [estimate, setEstimate] = useState<NetworkEstimate | null>(null);
  const [result, setResult] = useState<{ approveTx?: string; txHash: string; leafIndex: number } | null>(null);
  const [status, setStatus] = useState("");
  const [leftover, setLeftover] = useState<bigint | null | "unknown">(null);
  const [revoked, setRevoked] = useState<string | null>(null);
  const [nudge, setNudge] = useState(!nudgeDismissed);
  const units = asset ? parseAmount(asset, amount) : 0n;
  const priced = feedsConfigured(p.deployment);
  useEffect(() => {
    if (priced) void priceStore.refresh(p.deployment);
  }, [p.deployment, priced]);

  // the connected wallet's balance of the asset, through its own provider
  useEffect(() => {
    let live = true;
    setPublicBalance(null);
    if (!p.account || !asset) return;
    readPublicBalance(p.account, asset.token).then((b) => {
      if (live) setPublicBalance(b);
    });
    return () => {
      live = false;
    };
  }, [p.account, asset]);
  // the network cost at the wallet's own gas price, for this amount
  useEffect(() => {
    let live = true;
    setEstimate(null);
    if (!p.deployment || !p.account || !asset || units <= 0n) return;
    const d = p.deployment;
    const id = setTimeout(() => {
      estimateShieldCost(d, asset, units, p.account).then((e) => {
        if (live) setEstimate(e);
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [p.deployment, p.account, asset, units]);

  const eth = availablePrice(prices.prices, "ETH");
  const price = asset ? availablePrice(prices.prices, asset.symbol) : null;
  const split = p.deployment && units > 0n ? protectNet(p.deployment, units) : null; // V6: ProtectRouter's 1 %, rounded up
  const assessment = asset && units > 0n && priced ? priceStore.assess(units, asset) : null;
  const tier: Tier = assessment?.tier ?? "standard";
  const model = asset
    ? {
        ...protectModel({
          asset: { symbol: asset.symbol, decimals: asset.decimals },
          account: p.account,
          balance: publicBalance,
          amount,
          units,
          split,
          networkWei: estimate?.wei ?? null,
          ethUsd1e8: eth?.usd1e8 ?? null,
        }),
        connect: p.account || p.wrongNetwork ? null : { connecting: !!p.connecting },
        ...(p.wrongNetwork && !p.account ? { switchNetwork: true } : {}),
        ...(advanced
          ? {
              chips: chipBuckets(asset.decimals).map((b) => ({
                label: `${displayAmount(amountOf(b, asset.symbol, asset.decimals))} ${asset.symbol}`,
                value: formatUnits(b, asset.decimals),
              })),
            }
          : {}),
      }
    : null;
  const options: AssetOption[] = assets.map((a) => ({
    id: a.vault,
    symbol: a.symbol,
    name: a.symbol,
    decimals: a.decimals,
    ...(a.token ? { address: a.token } : {}),
  }));

  const router = p.deployment?.protectRouter;
  const checkLeftover = useCallback(async () => {
    if (!asset?.token) return;
    const provider = activeProvider();
    const [from] = (provider ? await provider.request({ method: "eth_accounts" }).catch(() => []) : []) as `0x${string}`[];
    if (!from) {
      setLeftover("unknown");
      return;
    }
    const a = await readAllowance(asset.token, from, router ?? asset.vault); // V6: the router pulls a protect's tokens
    setLeftover(a === null ? "unknown" : a);
  }, [asset, router]);
  async function revokeLeftover() {
    if (!asset?.token || !p.deployment) return;
    try {
      const tx = await revokeAllowance(asset.token, router ?? asset.vault, p.deployment.chainId);
      setRevoked(tx);
      setLeftover(0n);
    } catch (e) {
      setStatus(classify(e).detail);
    }
  }

  /** The confirmation: the operation is recorded, the wallet asked, the engine's events follow it. */
  async function run() {
    const deployment = p.deployment;
    if (!deployment || !asset) {
      setStatus(t("protect.noDeployment"));
      return;
    }
    nudgeDismissed = true; // shown once per session
    const rec = newOperation({
      kind: "protect",
      amounts: { asset: asset.symbol, decimals: asset.decimals, input: units.toString(), ...(split ? { expectedOutput: split.net.toString() } : {}) },
      destination: { kind: "privacy-address", display: t("protect.toBalance"), chain: "ethereum" },
      tier,
    });
    applyEvent(rec.id, { type: "review" });
    applyEvent(rec.id, { type: "confirm" });
    setStatus("");
    setLeftover(null);
    setRevoked(null);
    setResult(null);
    // the confirmed Review gives its place to the progress (c48): browser Back never shows it again
    navigate(`/protect/progress/${rec.id}`, { replace: true });
    const onEvent = engineListener((ev) => {
      applyEvent(rec.id, ev);
    });
    try {
      const r = asset.token
        ? await shieldERC20({
            masterSeed: p.masterSeed,
            deployment,
            token: asset.token,
            vault: asset.vault,
            amount: units,
            estimatedWei: estimate?.wei,
            onStatus: setStatus,
            onEvent,
          })
        : await shieldNative({ masterSeed: p.masterSeed, deployment, amount: units, estimatedWei: estimate?.wei, onStatus: setStatus, onEvent });
      setResult(r);
    } catch (e) {
      const c = classify(e);
      const first = c.code === "user_rejected" ? applyEvent(rec.id, { type: "rejected", code: c.code, detail: c.detail }) : null;
      if (!first || !first.ok) {
        const second =
          c.fundsClass === "unknown"
            ? applyEvent(rec.id, { type: "recovery-required", code: c.code, detail: c.detail })
            : applyEvent(rec.id, { type: "submission-failed", code: c.code, detail: c.detail });
        if (!second || !second.ok) applyEvent(rec.id, { type: "submission-failed", code: c.code, detail: c.detail });
      }
      if (asset.token) void checkLeftover();
    }
  }

  const backupCard =
    !pf.backup && nudge ? (
      <SecurityCard
        title={t("backup.title")}
        body={t("backup.body")}
        testId="backup-nudge"
        action={
          <div className="ds-actions">
            <Button
              variant="secondary"
              onClick={() => {
                nudgeDismissed = true;
                setNudge(false);
                p.onBackup?.();
              }}
              data-testid="backup-now"
            >
              {t("backup.now")}
            </Button>
            <TextButton
              onClick={() => {
                nudgeDismissed = true;
                setNudge(false);
              }}
              data-testid="backup-later"
            >
              {t("backup.later")}
            </TextButton>
          </div>
        }
      />
    ) : null;

  const review: ReviewModel | null =
    asset && split && model?.quote
      ? {
          kind: "protect",
          pay: { usdCents: price ? centsOf(units, asset.decimals, price.usd1e8) : null, amount: amountOf(units, asset.symbol, asset.decimals) },
          receive: { amount: amountOf(split.net, asset.symbol, asset.decimals), approx: false },
          fees: [
            {
              kind: "privacy",
              usdCents: price ? centsOf(split.fee, asset.decimals, price.usd1e8) : null,
              amount: amountOf(split.fee, asset.symbol, asset.decimals),
            },
            { kind: "relayer", usdCents: model.quote.networkUsdCents },
          ],
          totalFeesUsdCents:
            price && model.quote.networkUsdCents !== null ? centsOf(split.fee, asset.decimals, price.usd1e8) + model.quote.networkUsdCents : null,
          destination: { label: t("protect.toBalance"), verified: true },
          protection: "high",
          large: false,
          hold: controlsFor(tier).hold,
          confirmDisabled: !net.online,
        }
      : null;

  const form = model ? (
    <>
      <ProtectView
        model={model}
        actions={{
          onAmount: setAmount,
          onAsset: () => setPicking(true),
          ...(publicBalance !== null && asset ? { onMax: () => setAmount(formatAmount(asset, publicBalance)) } : {}),
          onReview: () => navigate("/protect/review"),
          onBack: p.onBack,
          ...(p.onConnect ? { onConnect: p.onConnect } : {}),
          ...(p.onSwitch ? { onSwitch: p.onSwitch } : {}),
          onChip: setAmount,
        }}
      />
      <AssetSelector
        open={picking}
        onClose={() => setPicking(false)}
        assets={options}
        value={asset?.vault}
        onChange={(id) => {
          const a = assets.find((x) => x.vault === id);
          if (a) {
            setAsset(a);
            setAmount("");
          }
          setPicking(false);
        }}
        title={t("protect.as")}
        searchLabel={t("protect.search")}
        testId="protect-asset-selector"
      />
    </>
  ) : (
    <Page title={t("protect.title")} back={p.onBack} testId="protect-view">
      <p className="ds-note-warn">{t("protect.noDeployment")}</p>
    </Page>
  );

  return (
    <Routes>
      <Route index element={form} />
      <Route
        path="review"
        element={
          review ? (
            <ReviewView model={review} actions={{ onConfirm: () => void run(), onEdit: () => navigate("/protect") }} extra={backupCard} holdMs={holdMs()} />
          ) : (
            <Navigate to="/protect" replace />
          )
        }
      />
      <Route
        path="progress/:opId"
        element={
          <ProtectProgress
            asset={asset ?? null}
            result={result}
            status={status}
            advanced={advanced}
            leftover={leftover}
            revoked={revoked}
            onRevoke={() => void revokeLeftover()}
            onBackToReview={() => navigate("/protect/review")}
            onAgain={() => {
              setAmount("");
              setResult(null);
              navigate("/protect");
            }}
            onDone={() => p.onDone?.()}
          />
        }
      />
      <Route path="*" element={<Navigate to="/protect" replace />} />
    </Routes>
  );
}

interface ProgressProps {
  asset: Asset | null;
  result: { approveTx?: string; txHash: string; leafIndex: number } | null;
  status: string;
  advanced: boolean;
  leftover: bigint | null | "unknown";
  revoked: string | null;
  onRevoke: () => void;
  onBackToReview: () => void;
  onAgain: () => void;
  onDone: () => void;
}

/** /protect/progress/:opId — the lines while the operation runs, what was added once it is in, the verdict when it stopped. */
function ProtectProgress(p: ProgressProps) {
  const t = useT();
  const { opId } = useParams();
  const record = useOperation(opId ?? null);
  const [furthest, setFurthest] = useState(0);
  useEffect(() => {
    if (record) setFurthest((f) => furthestLine(f, record));
  }, [record]);
  if (!record) return <Navigate to="/protect" replace />;
  const asset = p.asset;
  const net = record.amounts.expectedOutput ?? record.amounts.input;
  if (record.state === "COMPLETED") {
    const added = displayAmount(amountFrom(net, record.amounts.asset, record.amounts.decimals)); // the record's own asset: a reload may start on another one
    const symbol = record.amounts.asset;
    return (
      <Page title={t("protect.title")} back={p.onDone} testId="protect-view">
        <SuccessCard
          testId="protect-done"
          title={t("protect.done", { amount: added, symbol })}
          body={
            p.advanced && p.result ? (
              <p className="ds-note">
                {t("protect.doneAdvanced", { amount: added, symbol, leaf: p.result.leafIndex, hash: `${p.result.txHash.slice(0, 10)}…` })}
              </p>
            ) : undefined
          }
          actions={
            <>
              <Button onClick={p.onDone} data-testid="protect-finish">
                {t("protect.doneButton")}
              </Button>
              <Button variant="secondary" onClick={p.onAgain} data-testid="protect-again">
                {t("protect.again")}
              </Button>
            </>
          }
        />
        {p.advanced && p.result ? (
          <Collapsible summary={t("protect.technical")} testId="protect-technical">
            <div className="ds-kv">
              <span className="ds-kv-label">{t("protect.leaf", { leaf: p.result.leafIndex })}</span>
              <span className="ds-mono-break">{p.result.txHash}</span>
            </div>
            {p.result.approveTx ? (
              <div className="ds-kv">
                <span className="ds-kv-label">{t("protect.approveTx")}</span>
                <span className="ds-mono-break">{p.result.approveTx}</span>
              </div>
            ) : null}
          </Collapsible>
        ) : null}
      </Page>
    );
  }
  const stopped = record.reason || (record.declined && ["DRAFT", "QUOTING", "REVIEW"].includes(record.state)) || ["FAILED", "CANCELLED"].includes(record.state);
  // an outcome not known yet (c47): another protect from the form could deposit twice — only Done
  if (stopped && (record.state === "RECOVERY_REQUIRED" || record.reason?.fundsClass === "unknown")) {
    return (
      <Page title={t("protect.title")} back={p.onDone} testId="protect-view">
        <OperationProgress
          record={record}
          actions={
            <Button onClick={p.onDone} data-testid="protect-done-unknown">
              {t("protect.doneButton")}
            </Button>
          }
        />
      </Page>
    );
  }
  if (stopped) {
    return (
      <Page title={t("protect.title")} back={p.onBackToReview} testId="protect-view">
        <OperationProgress
          record={record}
          actions={
            <Button variant="secondary" onClick={p.onBackToReview} data-testid="protect-back">
              {t("protect.backToForm")}
            </Button>
          }
        />
        {asset?.token && p.leftover !== null ? (
          <Card testId="leftover-allowance">
            <p className="ds-note">
              {p.leftover === "unknown"
                ? t("protect.leftoverUnknown")
                : p.leftover > 0n
                  ? t("protect.leftoverRemains", { amount: displayAmount(amountOf(p.leftover, asset.symbol, asset.decimals)), symbol: asset.symbol })
                  : t("protect.leftoverNone")}
              {p.revoked ? ` ${t("protect.revoked", { hash: `${p.revoked.slice(0, 10)}…` })}` : ""}
            </p>
            {p.leftover !== "unknown" && p.leftover > 0n ? (
              <Button variant="secondary" onClick={p.onRevoke} data-testid="revoke-leftover">
                {t("protect.revoke")}
              </Button>
            ) : null}
          </Card>
        ) : null}
      </Page>
    );
  }
  return (
    <div data-state={record.state} data-testid="protect-progress">
      <ProgressView model={progressModelOf(record, furthest)} />
      {p.advanced && p.status ? (
        <p className="ds-note" data-testid="protect-status">
          {p.status}
        </p>
      ) : null}
    </div>
  );
}
