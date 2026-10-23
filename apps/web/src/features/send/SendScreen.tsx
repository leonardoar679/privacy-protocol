// Send (spec v2.0 §7.4, §7.6–§7.7, §2; doc §24–§25, §58): one screen for every destination, on the V6 screens —
// /send the one page (SendView: the amount, the destination with its checks, what the recipient receives — largest —, the
// privacy fee and the relayer's), /send/review the Review, /send/progress/:opId the progress lines, then what was sent or
// the verdict. A privacy address sends privately inside the pool (sdk privateTransfer), an EVM address on the pool's
// chain is a public exit (privateWithdrawal; a fresh address of this wallet is one tap away and is reserved at the
// confirmation), a Bitcoin address continues as a cross-chain send in the swap flow, an address that names another chain
// asks first — the network never changes silently. Exact input by default; "Recipient receives exactly this amount" is
// the exact output. The bands (spec v2.0 §2): from $20K the privacy lint and a typed-in destination re-confirmed, from
// $50K a hold, from high-value the address book's lock (its status and way forward under the address); from `enhanced`
// ($100K) the V2–V4 Review stays as it was. A fresh address is reserved once, at the first confirmation, and kept for a
// retry of the same send; once the exit went through it counts as used (an entered address from then on) and "Send
// again" clears it, so the next exit gets the next address. Nothing that the Review route reads changes after the
// confirmation: the route stays valid while the navigation to the progress route commits.
import { useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import type { Address } from "viem";
import { groupAddress } from "@privacy-wallet/protocol/wallet/destinations";
import { unacknowledgedBlocks, type LintId } from "@privacy-wallet/protocol/wallet/privacyLint";
import { atLeast, availablePrice, formatUsd, type Tier } from "@privacy-wallet/protocol/wallet/valuation";
import { AssetSelector, Button, Card, Page, SuccessCard, TextButton, type AssetOption } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { destinationStatusWords, destinationWords } from "../destinationWords";
import { knownRecipients } from "../recipients";
import { assetsOf, formatAmount, isBucketFor, parseAmount, type Asset } from "@privacy-wallet/sdk/assets";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { HousekeepingNeeded, privateTransfer, privateWithdrawal, maxSpendable } from "@privacy-wallet/sdk/privateTx";
import { consumeFreshAddress, peekFreshAddress } from "@privacy-wallet/sdk/keys/chainKeys";
import { feedsConfigured, priceStore } from "@privacy-wallet/sdk/prices";
import { holdersAbove } from "@privacy-wallet/sdk/poolDeposits";
import { controlsFor, holdMs, issuerLine } from "@privacy-wallet/sdk/tiers";
import { downloadText } from "@privacy-wallet/sdk/download";
import { destinationCheck, markAddressSettled, markAddressUsed } from "@privacy-wallet/sdk/wallet/addressBook";
import { scheduleHousekeeping } from "@privacy-wallet/sdk/wallet/housekeeping";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { mergeSchedule } from "@privacy-wallet/sdk/wallet/mergeSchedule";
import { topBucket, walletLint } from "@privacy-wallet/sdk/wallet/lintFacts";
import { applyEvent, newOperation } from "@privacy-wallet/sdk/operations/store";
import { engineListener } from "@privacy-wallet/sdk/operations/engineEvents";
import { classify } from "@privacy-wallet/sdk/operations/errors/catalog";
import { PrivacyLint } from "../../components/PrivacyLint";
import { DestinationStatus } from "../../components/protection/AddressBook";
import { Review, type ReviewLine } from "../review/ReviewScreen";
import { ReviewView, type ReviewModel } from "../review/View";
import { OperationProgress } from "../operations/OperationProgress";
import { ProgressView } from "../progress/View";
import { furthestLine, progressModelOf } from "../progress/model";
import { useFeeTerms } from "../fees/useFeeTerms";
import { amountFrom, amountOf, centsOf, displayAmount } from "../amounts";
import type { SwapPrefill } from "../swap/Swap";
import { SendView } from "./View";
import { crossTargetOf, destinationOf, sendModel, sendSplit } from "./model";
import { useAddressBook, useConnectivity, useNotes, useOperation, usePrices, useSettings } from "../../hooks";

export interface SendScreenProps {
  masterSeed: Uint8Array;
  deployment: Deployment | null;
  /** the connected public wallet, if any: sending to it is flagged */
  account?: string | null;
  onBack?: () => void;
  onDone?: () => void;
}
interface Result {
  txHash: string;
  proofMs: number;
  verifiedLocally: boolean;
  leafIndex?: number;
}

const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export function SendScreen(p: SendScreenProps) {
  const t = useT();
  const navigate = useNavigate();
  const { submission, advanced, verifyReads, secondFactor, protection } = useSettings();
  const net = useConnectivity(); // V6 Stage 15 (doc §75): no Confirm while offline
  const book = useAddressBook();
  const prices = usePrices();
  useNotes();
  const assets = useMemo(() => assetsOf(p.deployment), [p.deployment]);
  const [asset, setAsset] = useState<Asset | undefined>(assets[0]);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [exact, setExact] = useState(false);
  const [otherChainOk, setOtherChainOk] = useState(false);
  const [picking, setPicking] = useState(false);
  const [acknowledged, setAcknowledged] = useState<LintId[]>([]);
  const [destAck, setDestAck] = useState(false);
  const [reserved, setReserved] = useState<{ address: string; used: boolean } | null>(null);
  const [holders, setHolders] = useState<number | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [status, setStatus] = useState("");
  const [consolidate, setConsolidate] = useState(false);
  const [busy, setBusy] = useState(false);

  const units = asset ? parseAmount(asset, amount) : 0n;
  const known = useMemo(() => knownRecipients(p.deployment), [p.deployment]);
  const dest = destinationOf(to, p.deployment?.chainId ?? 1, known);
  const relayed = dest.kind === "private" || dest.kind === "public";
  const terms = useFeeTerms(asset && units > 0n && relayed ? asset.vault : null); // read once an amount is typed: no request before the user acts
  // submitted through the connected wallet (Advanced): no relayer and no fee note — what is typed arrives, the wallet pays the network
  const selfSubmitted = terms.status === "public";
  const split =
    !asset || !relayed || units <= 0n
      ? null
      : terms.status === "ready" && terms.terms
        ? sendSplit(units, terms.terms, exact)
        : selfSubmitted
          ? { total: units, delivered: units, fee: 0n, privacy: 0n, network: 0n, tooSmall: false }
          : null;
  const priced = feedsConfigured(p.deployment);
  const assessment = asset && units > 0n && priced ? priceStore.assess(units, asset) : null;
  // the band of what leaves, not of what is typed (2026-10-17, the audit's unverified m59): an exact output's total is the
  // typed amount and its fees, so $49.6K to arrive — about $50.1K leaving — is held, never a tap
  const leaving = asset && split && split.total > units && priced ? priceStore.assess(split.total, asset) : assessment;
  const tier: Tier = leaving?.tier ?? "standard";
  const controls = controlsFor(tier);
  const price = asset ? availablePrice(prices.prices, asset.symbol) : null;
  const usd = assessment && "usd" in assessment.value ? formatUsd(assessment.value.usd) : null;
  useEffect(() => {
    if (priced) void priceStore.refresh(p.deployment);
  }, [p.deployment, priced]);
  useEffect(() => {
    if (!p.deployment || !asset || dest.kind !== "public" || units <= topBucket(asset.decimals)) {
      setHolders(null);
      return;
    }
    let live = true;
    holdersAbove(p.deployment, asset.vault, units)
      .then((h) => {
        if (live) setHolders(h);
      })
      .catch(() => {
        if (live) setHolders(null);
      });
    return () => {
      live = false;
    };
  }, [p.deployment, units, asset, dest.kind]);

  const fresh = peekFreshAddress(p.masterSeed, "evm").address;
  const same = (a: string, b: string | null) => b !== null && a.toLowerCase() === b.toLowerCase();
  const reservedFor = (a: string) => !!reserved && !reserved.used && same(a, reserved.address); // reserved for this send and not used yet
  const destinationKind: "fresh" | "entered" | "privacy-address" =
    dest.kind === "private" ? "privacy-address" : dest.kind === "public" && (same(dest.address, fresh) || reservedFor(dest.address)) ? "fresh" : "entered";
  const destCheck = dest.kind === "public" && destinationKind === "entered" ? destinationCheck("evm", dest.address, { tier }) : null;
  const destinationLocked = controls.destinationLock && !!destCheck && !destCheck.ok;
  const ownWallet = dest.kind === "public" && !!p.account && dest.address.toLowerCase() === p.account.toLowerCase();
  const balance = asset ? noteStore.balance(BigInt(asset.vault)) : 0n;
  const total = split?.total ?? units;
  // the merges a spend of three notes or more needs first, each paying the relayer's minimum (audit round 2, r43): named on
  // the Review, counted in what leaves and in the balance check, and bounded at the confirmation — they had been none of these
  const mergeEach = terms.status === "ready" && terms.terms ? terms.terms.minimum : 0n;
  const mergeCount =
    asset && split && mergeEach > 0n
      ? mergeSchedule(
          noteStore.unspent(BigInt(asset.vault)).map((n) => ({ id: String(n.leafIndex), amount: n.note.amount })),
          split.total,
          mergeEach,
        ).pairs.length
      : 0;
  const mergeFees = BigInt(mergeCount) * mergeEach;
  const lint =
    asset && units > 0n && relayed && (controls.lint || dest.kind === "public")
      ? walletLint({
          action: dest.kind === "private" ? "transfer" : "withdraw",
          tier,
          deployment: p.deployment,
          settings: { submission, verifyReads },
          destination: dest.kind === "private" || dest.kind === "public" ? dest.address : "",
          destinationKind,
          account: dest.kind === "private" ? null : (p.account ?? null),
          delaySeconds: 0,
          amount: units,
          decimals: asset.decimals,
          amountIsBucket: dest.kind === "private" ? true : isBucketFor(asset, units),
          holders: dest.kind === "public" ? holders : undefined,
          acknowledged,
        })
      : null;
  const blocked = lint ? unacknowledgedBlocks(lint).length > 0 : false;
  // spec v2.0 §2: from the Medium band a typed-in destination is confirmed group by group before the signature
  const needsDestAck = dest.kind === "public" && destinationKind === "entered" && atLeast(tier, "large");

  const bookEntries = [
    { id: "fresh", label: t("send.freshEntry"), address: fresh },
    ...book
      .filter((e) => e.chain === "evm" && e.verification.status === "verified" && e.lifecycle !== "retired" && e.lifecycle !== "generated")
      .map((e) => ({ id: e.id, label: e.label ?? short(e.address), address: e.address })),
  ];
  const crossTarget = asset ? crossTargetOf(dest, asset.symbol) : null;
  const unreachable = (dest.kind === "bitcoin" || dest.kind === "other-chain") && !crossTarget;
  const model = {
    ...sendModel({
      asset: asset ? { symbol: asset.symbol, decimals: asset.decimals } : null,
      amount,
      to,
      destination: dest,
      exact,
      split,
      otherChainConfirmed: otherChainOk,
      selfSubmitted,
      book: bookEntries,
    }),
    balance: asset ? amountOf(balance, asset.symbol, asset.decimals) : null,
    amountUsd: usd,
    amountError: asset && relayed && units > 0n && split && balance < total + mergeFees ? t("send.notEnough", { symbol: asset.symbol }) : null,
    addressError:
      dest.kind === "invalid"
        ? destinationWords(t, dest)
        : unreachable
          ? t("screen.send.chainUnsupported", { chain: dest.kind === "other-chain" ? dest.chain : "Bitcoin" })
          : null,
    destinationNote: ownWallet ? t("screen.send.ownWallet") : destinationLocked && destCheck ? destinationStatusWords(t, destCheck) : null,
    notice: assessment && tier !== "standard" ? (assessment.failSafe ? t("send.largeNoticeFailSafe") : t("send.largeNotice")) : null,
  };
  if (model.amountError || destinationLocked || unreachable) model.canReview = false;
  if (unreachable) model.otherChain = null; // nothing to confirm: the chain is out of reach
  const addressStatus =
    controls.destinationLock && dest.kind === "public" && destinationKind === "entered" && asset ? (
      <DestinationStatus chain="evm" address={dest.address} tier={tier} masterSeed={p.masterSeed} deployment={p.deployment} asset={asset.symbol} />
    ) : null;

  /** A Bitcoin or another chain's destination continues as a cross-chain send in the swap flow (spec v2.0 §7.4–§7.5). */
  function continueCrossChain() {
    if (!asset || !crossTarget || (dest.kind !== "bitcoin" && dest.kind !== "other-chain")) return;
    const prefill: SwapPrefill = { fromVault: asset.vault, amount, target: crossTarget.id, destination: dest.address };
    navigate("/swap", { state: { prefill } });
  }

  async function run() {
    const deployment = p.deployment;
    if (!deployment || !asset || !split || (dest.kind !== "private" && dest.kind !== "public")) {
      setStatus(t("protect.noDeployment"));
      return;
    }
    if (balance < split.total + mergeFees) {
      setStatus(t("send.notEnough", { symbol: asset.symbol }));
      return;
    }
    // the fresh address is reserved at the first confirmation and kept for a retry of this send
    const recipient =
      destinationKind !== "fresh" ? dest.address : reservedFor(dest.address) ? reserved!.address : consumeFreshAddress(p.masterSeed, "evm").address;
    if (destinationKind === "fresh") setReserved({ address: recipient, used: false });
    // the record's fee lines say what the page said: the privacy fee when there is one, the relayer's charge or who pays the network
    const feeLines = [
      ...(split.privacy > 0n ? [{ label: t("screen.send.privacyFee"), value: `${formatAmount(asset, split.privacy)} ${asset.symbol}` }] : []),
      { label: t("screen.send.relayer"), value: selfSubmitted ? t("screen.send.paidByWallet") : `${formatAmount(asset, split.network)} ${asset.symbol}` },
      ...(mergeCount ? [{ label: t("screen.review.mergeFees", { n: mergeCount }), value: `${formatAmount(asset, mergeFees)} ${asset.symbol}` }] : []),
    ];
    const rec = newOperation({
      kind: dest.kind === "private" ? "send" : "withdraw",
      amounts: { asset: asset.symbol, decimals: asset.decimals, input: split.total.toString(), expectedOutput: split.delivered.toString() },
      destination: { kind: destinationKind, display: recipient, chain: "ethereum" },
      tier,
      fees: feeLines,
    });
    applyEvent(rec.id, { type: "review" });
    applyEvent(rec.id, { type: "confirm" });
    setStatus("");
    setConsolidate(false);
    setResult(null);
    setBusy(true);
    // the confirmed Review gives its place to the progress (the audit round of 2026-10-16, c48): browser Back never shows it
    // again, one tap from a second send
    navigate(`/send/progress/${rec.id}`, { replace: true });
    const onEvent = engineListener((ev) => {
      applyEvent(rec.id, ev);
      // a public exit's recipient is used once it is sent (audit round 2, r32): Receive had offered a fresh address a
      // withdrawal paid as unused, and an entered one never counted as reused
      if (ev.type === "submitted" && dest.kind === "public") markAddressUsed("evm", recipient, rec.id);
    });
    try {
      if (dest.kind === "private") {
        const r = await privateTransfer({
          masterSeed: p.masterSeed,
          deployment,
          amount: split.delivered,
          recipient,
          vault: asset.vault,
          ...(selfSubmitted ? {} : { maxFee: split.fee }), // never more than the Review showed (the audit round of 2026-10-16, c46)
          ...(mergeCount && !selfSubmitted ? { maxMergeFee: mergeEach } : {}), // nor for a merge (audit round 2, r43)
          onStatus: setStatus,
          onEvent,
        });
        setResult({ txHash: r.txHash, proofMs: r.proofMs, verifiedLocally: r.verifiedLocally, leafIndex: r.recipientNote.leafIndex });
      } else {
        const r = await privateWithdrawal({
          masterSeed: p.masterSeed,
          deployment,
          amount: split.delivered,
          recipient: recipient as Address,
          vault: asset.vault,
          ...(selfSubmitted ? {} : { maxFee: split.fee }), // never more than the Review showed (c46)
          ...(mergeCount && !selfSubmitted ? { maxMergeFee: mergeEach } : {}), // nor for a merge (r43)
          onStatus: setStatus,
          onEvent,
        });
        setResult({ txHash: r.txHash, proofMs: r.proofMs, verifiedLocally: r.verifiedLocally });
        markAddressSettled("evm", recipient); // paid: a fresh address retires, an entered one stays usable, its reuse warned (r32)
        if (destinationKind === "fresh") setReserved({ address: recipient, used: true }); // used: the next exit gets the next fresh address
      }
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
      setConsolidate(e instanceof HousekeepingNeeded); // the balance is there, spread over too many notes: the maintenance step is offered now
    } finally {
      setBusy(false);
    }
  }

  const options: AssetOption[] = assets.map((a) => ({
    id: a.vault,
    symbol: a.symbol,
    name: a.symbol,
    decimals: a.decimals,
    ...(a.token ? { address: a.token } : {}),
    balance: `${formatAmount(a, noteStore.balance(BigInt(a.vault)))} ${a.symbol}`,
  }));
  const form = asset ? (
    <>
      <SendView
        model={model}
        addressStatus={addressStatus}
        actions={{
          onAmount: setAmount,
          onTo: (v) => {
            setTo(v);
            setOtherChainOk(false);
            setDestAck(false);
            setAcknowledged([]);
          },
          onExact: setExact,
          onReview: () => (model.action === "continue" ? continueCrossChain() : navigate("/send/review")),
          onConfirmChain: () => setOtherChainOk(true),
          onPickEntry: (id) => {
            const e = bookEntries.find((x) => x.id === id);
            if (e) {
              setTo(e.address);
              setDestAck(false);
            }
          },
          ...(assets.length > 1 ? { onAsset: () => setPicking(true) } : {}),
          ...(balance > 0n
            ? {
                // the merges a spend of every note needs are paid out of it (the audit's unverified m55), whatever the destination
                // (audit round 2, r08): the amount field comes first, and a Max pressed before it was the whole balance —
                // refused at the confirmation for the merges a spend of three notes or more pays
                onMax: () => {
                  if (noteStore.unspent(BigInt(asset.vault)).length <= 2 || !p.deployment) return setAmount(formatAmount(asset, balance));
                  void maxSpendable(p.deployment, asset.vault).then(
                    (m) => setAmount(formatAmount(asset, m)),
                    () => setAmount(formatAmount(asset, balance)),
                  );
                },
              }
            : {}),
          onBack: p.onBack,
        }}
      />
      <AssetSelector
        open={picking}
        onClose={() => setPicking(false)}
        assets={options}
        value={asset.vault}
        onChange={(id) => {
          const a = assets.find((x) => x.vault === id);
          if (a) {
            setAsset(a);
            setAmount("");
          }
          setPicking(false);
        }}
        title={t("send.asset")}
        searchLabel={t("protect.search")}
        testId="send-asset-selector"
      />
    </>
  ) : (
    <Page title={t("screen.send.title")} back={p.onBack} testId="send-view">
      <p className="ds-note-warn">{t("protect.noDeployment")}</p>
    </Page>
  );

  // the Review: the V2–V4 screen from `enhanced`, else the V6 one with what the band adds
  const reviewPage = (() => {
    if (!asset || !split || (dest.kind !== "private" && dest.kind !== "public")) return <Navigate to="/send" replace />;
    const format = (u: bigint) => `${formatAmount(asset, u)} ${asset.symbol}`;
    if (atLeast(tier, "enhanced")) {
      const lines: ReviewLine[] =
        dest.kind === "private"
          ? [
              {
                id: "price",
                label: t("review.amountFixed"),
                ok: true,
                meaning: t("review.amountFixedPrivate", { amount: formatAmount(asset, split.total), symbol: asset.symbol }),
              },
              { id: "route", label: t("review.routeChecked"), ok: true, meaning: t("review.routePrivate") },
              { id: "destination", label: t("review.destinationVerified"), ok: true, meaning: t("review.destinationPrivate") },
              {
                id: "slippage",
                label: t("review.noSlippage"),
                ok: true,
                meaning: t("review.noSlippageMeaning", { amount: formatAmount(asset, split.delivered), symbol: asset.symbol }),
              },
              { id: "privacy", label: t("review.privacyReviewed"), ok: !blocked, meaning: t("review.privacyReviewedMeaning") },
            ]
          : [
              {
                id: "price",
                label: t("review.amountFixed"),
                ok: true,
                meaning: t("review.amountFixedPublic", { amount: formatAmount(asset, split.delivered), symbol: asset.symbol }),
              },
              { id: "route", label: t("review.routeChecked"), ok: true, meaning: t("review.routePublic") },
              {
                id: "destination",
                label: t("review.destinationVerified"),
                ok: destinationKind === "fresh" || (destAck && !destinationLocked),
                meaning:
                  destinationKind === "entered"
                    ? `${t("review.destinationEntered")}${destCheck ? `; ${destinationStatusWords(t, destCheck)}` : ""}`
                    : t("review.destinationFresh"),
                ...(destinationKind === "entered" && !destAck
                  ? { ack: { text: t("review.checkedGroups"), done: destAck, onAck: () => setDestAck(true) } }
                  : {}),
              },
              {
                id: "slippage",
                label: t("review.noSlippage"),
                ok: true,
                meaning: t("review.noSlippageMeaning", { amount: formatAmount(asset, split.delivered), symbol: asset.symbol }),
              },
              { id: "privacy", label: t("review.privacyReviewed"), ok: !blocked, meaning: t("review.privacyReviewedMeaning") },
            ];
      const exportReview = controls.export
        ? () =>
            downloadText(
              `privacy-wallet-${dest.kind === "private" ? "transfer" : "withdrawal"}-review-${Date.now()}.json`,
              JSON.stringify(
                {
                  format: `privacy-protocol/${dest.kind === "private" ? "transfer" : "withdrawal"}-review/v1`,
                  exportedAt: new Date().toISOString(),
                  asset: asset.symbol,
                  amount: split.total.toString(),
                  delivered: split.delivered.toString(),
                  recipient: dest.address,
                  tier,
                  usd,
                  lint: lint ?? [],
                },
                null,
                2,
              ),
            )
        : undefined;
      return (
        <Page title={t("screen.send.title")} back={() => navigate("/send")} testId="send-view">
          <Review
            moment={dest.kind === "private" ? "send" : "withdraw"}
            tier={tier}
            controls={controls}
            usd={usd}
            amount={format(split.total)}
            from={t("review.fromProtected", { symbol: asset.symbol })}
            to={
              dest.kind === "private"
                ? { network: t("review.privatePool"), asset: asset.symbol, address: dest.address, kind: "privacy-address" }
                : { network: t("review.ethereum"), asset: asset.symbol, address: dest.address, kind: destinationKind === "fresh" ? "fresh" : "entered" }
            }
            receiveMin={format(split.delivered)}
            privacy={{ level: dest.kind === "private" ? "Excellent" : destinationKind === "entered" ? "Reduced" : "Good" }}
            lint={lint ?? []}
            onAcknowledgeLint={(id) => setAcknowledged((a) => [...a, id])}
            lines={lines}
            issuer={issuerLine(asset.symbol)}
            advanced={advanced}
            onExport={exportReview}
            secondFactor={controls.secondFactor ? { credentialId: secondFactor.credentialId } : null}
            secondDevice={controls.secondDevice ? { credentialId: protection.secondDevice.credentialId } : null}
            busy={busy ? status : undefined}
            error={!busy && status ? status : undefined}
            onConfirm={() => void run()}
            onCancel={() => navigate("/send")}
          />
        </Page>
      );
    }
    const cents = (u: bigint) => (price ? centsOf(u, asset.decimals, price.usd1e8) : null);
    const privacyCents = cents(split.privacy),
      relayerCents = cents(split.network),
      mergeCents = mergeCount ? cents(mergeFees) : 0n;
    const review: ReviewModel = {
      kind: "send",
      pay: { usdCents: cents(split.total + mergeFees), amount: amountOf(split.total + mergeFees, asset.symbol, asset.decimals) },
      receive: { amount: amountOf(split.delivered, asset.symbol, asset.decimals), approx: false },
      fees: [
        ...(split.privacy > 0n ? [{ kind: "privacy" as const, usdCents: privacyCents, amount: amountOf(split.privacy, asset.symbol, asset.decimals) }] : []),
        ...(split.network > 0n ? [{ kind: "relayer" as const, usdCents: relayerCents, amount: amountOf(split.network, asset.symbol, asset.decimals) }] : []),
        ...(mergeCount
          ? [{ kind: "merges" as const, count: mergeCount, usdCents: mergeCents, amount: amountOf(mergeFees, asset.symbol, asset.decimals) }]
          : []),
      ],
      totalFeesUsdCents: privacyCents !== null && relayerCents !== null && mergeCents !== null ? privacyCents + relayerCents + mergeCents : null,
      destination: {
        label: dest.kind === "private" ? short(dest.address) : destinationKind === "fresh" ? t("send.freshEntry") : short(dest.address),
        verified: dest.kind === "private" || destinationKind === "fresh" || destAck,
      },
      protection: dest.kind === "private" ? "high" : destinationKind === "fresh" ? "medium" : "low",
      large: false,
      hold: controls.hold,
      confirmDisabled: blocked || destinationLocked || (needsDestAck && !destAck) || !net.online,
    };
    const extra = (
      <>
        {lint && lint.length ? <PrivacyLint items={lint} compact={dest.kind === "private"} onAcknowledge={(id) => setAcknowledged((a) => [...a, id])} /> : null}
        {needsDestAck ? (
          <Card padding="md" testId="send-destination-ack">
            <h2 className="ds-card-title">{t("screen.send.reviewDestination")}</h2>
            <p className="ds-mono-break" data-testid="send-destination-groups">
              {groupAddress(dest.address)}
            </p>
            {destAck ? (
              <p className="ds-note">✓ {t("screen.send.reviewDestinationDone")}</p>
            ) : (
              <Button variant="secondary" onClick={() => setDestAck(true)} data-testid="send-destination-ack-button">
                {t("screen.send.reviewDestinationBody")}
              </Button>
            )}
          </Card>
        ) : null}
        {status ? (
          <p className="ds-note-warn" data-testid="send-status">
            {status}
          </p>
        ) : null}
      </>
    );
    return <ReviewView model={review} actions={{ onConfirm: () => void run(), onEdit: () => navigate("/send") }} extra={extra} holdMs={holdMs()} />;
  })();

  return (
    <Routes>
      <Route index element={form} />
      <Route path="review" element={reviewPage} />
      <Route
        path="progress/:opId"
        element={
          <SendProgress
            result={result}
            status={status}
            advanced={advanced}
            consolidate={consolidate}
            onConsolidate={() => {
              const ok = scheduleHousekeeping(p.deployment, { now: true });
              setStatus(ok ? t("send.consolidateScheduled") : t("send.consolidateNotScheduled"));
            }}
            onBackToReview={() => {
              terms.refresh(); // a fee that moved past the Review's is read again, so the Review shows the new one (audit round 2, r09)
              navigate("/send/review");
            }}
            onEdit={() => navigate("/send")}
            onAgain={() => {
              setAmount("");
              setResult(null);
              if (reserved?.used) {
                if (same(to.trim(), reserved.address)) setTo(""); // the used fresh address is not offered again
                setReserved(null);
              }
              navigate("/send");
            }}
            onDone={() => p.onDone?.()}
          />
        }
      />
      <Route path="*" element={<Navigate to="/send" replace />} />
    </Routes>
  );
}

interface ProgressProps {
  result: Result | null;
  status: string;
  advanced: boolean;
  consolidate: boolean;
  onConsolidate: () => void;
  onBackToReview: () => void;
  onEdit: () => void;
  onAgain: () => void;
  onDone: () => void;
}

/** /send/progress/:opId — the lines while the operation runs, what was sent once it is in, the verdict when it stopped. */
function SendProgress(p: ProgressProps) {
  const t = useT();
  const { opId } = useParams();
  const record = useOperation(opId ?? null);
  const [furthest, setFurthest] = useState(0);
  useEffect(() => {
    if (record) setFurthest((f) => furthestLine(f, record));
  }, [record]);
  if (!record) return <Navigate to="/send" replace />;
  const delivered = record.amounts.expectedOutput ?? record.amounts.input;
  const amountText = displayAmount(amountFrom(delivered, record.amounts.asset, record.amounts.decimals)); // the record's own asset: a reload may start on another one
  const symbol = record.amounts.asset;
  if (record.state === "COMPLETED") {
    return (
      <Page title={t("screen.send.title")} back={p.onDone} testId="send-view">
        <SuccessCard
          testId="send-done"
          title={
            record.kind === "send"
              ? t("send.donePrivate", { amount: amountText, symbol })
              : t("send.donePublic", { amount: amountText, symbol, address: short(record.destination.display) })
          }
          body={
            p.advanced && p.result ? (
              <p className="ds-note">
                {t("send.doneAdvanced", {
                  hash: `${p.result.txHash.slice(0, 10)}…`,
                  seconds: (p.result.proofMs / 1000).toFixed(1),
                  verified: p.result.verifiedLocally ? t("send.verifiedLocally") : "",
                  leaf: p.result.leafIndex !== undefined ? t("send.recipientLeaf", { leaf: p.result.leafIndex }) : "",
                })}
              </p>
            ) : undefined
          }
          actions={
            <>
              <Button onClick={p.onDone} data-testid="send-finish">
                {t("send.doneButton")}
              </Button>
              <Button variant="secondary" onClick={p.onAgain} data-testid="send-again">
                {t("send.again")}
              </Button>
            </>
          }
        />
      </Page>
    );
  }
  const stopped = record.reason || (record.declined && ["DRAFT", "QUOTING", "REVIEW"].includes(record.state)) || ["FAILED", "CANCELLED"].includes(record.state);
  // an outcome not known yet (the audit round of 2026-10-16, c47): confirming again would plan from notes the first spend may
  // be using, and could pay twice — only Done; the record moves by the chain's answer
  const unknownOutcome = record.state === "RECOVERY_REQUIRED" || record.reason?.fundsClass === "unknown";
  if (stopped && unknownOutcome) {
    return (
      <Page title={t("screen.send.title")} back={p.onDone} testId="send-view">
        <OperationProgress
          record={record}
          actions={
            <Button onClick={p.onDone} data-testid="send-done-unknown">
              {t("send.doneButton")}
            </Button>
          }
        />
      </Page>
    );
  }
  if (stopped) {
    return (
      <Page title={t("screen.send.title")} back={p.onEdit} testId="send-view">
        <OperationProgress
          record={record}
          actions={
            <>
              <Button variant="secondary" onClick={p.onBackToReview} data-testid="send-back-review">
                {t("send.backToReview")}
              </Button>
              <TextButton onClick={p.onEdit} data-testid="send-edit">
                {t("send.edit")}
              </TextButton>
              {p.consolidate ? (
                <Button variant="secondary" onClick={p.onConsolidate} data-testid="consolidate-now">
                  {t("send.consolidateNow")}
                </Button>
              ) : null}
            </>
          }
        />
        {p.status ? (
          <p className="ds-note" data-testid="send-status">
            {p.status}
          </p>
        ) : null}
      </Page>
    );
  }
  return (
    <div data-state={record.state} data-testid="send-progress">
      <ProgressView model={progressModelOf(record, furthest)} />
      {p.advanced && p.status ? (
        <p className="ds-note" data-testid="send-status">
          {p.status}
        </p>
      ) : null}
    </div>
  );
}
