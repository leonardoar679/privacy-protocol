// The Classic app (V7 Stages 3 and 9): the original interface's one page — Deposit | Withdraw with the Statistics beside
// it — plus History and Settings, over the real services (the chain through the configured endpoints, each pool's
// verified history, the curated relayers, the prover worker, the connected wallet; src/app/services) or the Stage 3 mock
// when a test hands it in. This is the controller: the route, the selected pool, the note shown once and kept in memory
// only, the withdraw draft, the fee lines at the live gas price, the language, the wallet, the two flows. Nothing here
// sends a transaction while a pool function is not live (spec v3.0 §7.7): the sending buttons read "Not connected", the
// banner says so on every screen, and the flows refuse as well.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { config, isLive, POOL_IDS } from "../config";
import { feeLines } from "../model/fees";
import { isAddress, toChecksumAddress } from "../model/format";
import { refusedRecipient, tokenOfRecipient } from "../model/recipient";
import { mockSource } from "../model/mock";
import { formatNote, generateNote, noteFileName, parseNote, type ClassicNote } from "../model/notes";
import { NET_ID, poolOf, type PoolId } from "../model/pools";
import type { ClassicSource } from "../model/source";
import type { Availability, ConfirmTerms, FeeLines, HistoryRow, NoteLookup, PoolFunctionLive, PoolStats, RelayerInfo, WithdrawMode } from "../model/types";
import { readLocaleChoice, writeLocaleChoice } from "../storage/prefs";
import type { DiscoveredWallet } from "../wallet/injected";
import { ConnectModal, walletLabel } from "../views/Connect";
import { DepositTab, NoteModal } from "../views/Deposit";
import { History, type HistoryFilter } from "../views/History";
import { SettingsPage } from "../views/Settings";
import { Shell } from "../views/Shell";
import { Statistics } from "../views/Statistics";
import { WithdrawTab, type SpentOnChain } from "../views/Withdraw";
import { Notice } from "../views/ui";
import { en } from "./i18n/en";
import { detectLocale, locale, onLocale, setLocale, t, type LocaleChoice } from "./i18n/messages";
import { navigate, useRoute } from "./router";
import { geofenceAnswer, isSanctioned } from "./services/compliance";
import { depositFlow, FlowRefused, REVERTED, withdrawalFlow, type ProofTerms } from "./services/flows";
import { STALE_MS } from "./services/history";
import type { JobRecord } from "./services/operations";
import { isSpentOnChain } from "../history/spent";
import { createServices, factsOf, sourceOf, type ClassicServices, anyLive } from "./services/source";
import { canDeposit, canWithdraw as canWithdrawNow } from "../model/availability";
import { probeGeofence } from "../net/geofence";

/** The words of spec v3.0 §7.7 every build shows until a pool function is switched live (the English catalog's). */
export const NOT_CONNECTED = en["notice.notConnected"];

export interface AppProps {
  /** the data source: the mock in the Stage 3 tests; the real services' otherwise */
  source?: ClassicSource;
  /** the services (the flows, the wallet); the tests hand in scripted ones; absent with a mock source */
  services?: ClassicServices;
  /** a fixed clock in seconds (the tests'); the device's otherwise, ticking every minute */
  now?: number;
}

export function App(props: AppProps = {}) {
  const c = config();
  const now = useNow(props.now);
  const services = useMemo(() => props.services ?? (props.source ? null : createServices()), [props.services, props.source]);
  const source = useMemo(() => props.source ?? (services ? sourceOf(services) : mockSource({ now: Math.floor(Date.now() / 1000) })), [props.source, services]);
  const route = useRoute();

  // every change in the services redraws the tree (statuses, the wallet, the relayers); `version` counts them
  const [version, bump] = useState(0);
  const redraw = useCallback(() => bump((n) => n + 1), []);
  useEffect(() => services?.onChange(redraw), [services, redraw]);

  // the language: the stored choice, else the browser's; every change re-renders the tree
  useEffect(() => onLocale(redraw), [redraw]);
  const [localeChoice, setLocaleChoice] = useState<LocaleChoice>(() => readLocaleChoice());
  useEffect(() => {
    setLocale(localeChoice === "auto" ? detectLocale(typeof navigator === "undefined" ? undefined : navigator.language) : localeChoice);
    document.documentElement.lang = locale();
  }, [localeChoice]);
  const chooseLocale = (choice: LocaleChoice) => {
    setLocaleChoice(choice);
    writeLocaleChoice(choice);
  };

  // the geofence, behind its switch: the host's 451 ends the page here
  const [geofenced, setGeofenced] = useState(false);
  useEffect(() => {
    if (!c.geofence) return;
    let on = true;
    void probeGeofence(`${c.base}geo`).then((status) => on && setGeofenced(geofenceAnswer(status) === "blocked"));
    return () => {
      on = false;
    };
  }, [c.geofence, c.base]);

  // the pool: the original opened on 0.1 ETH
  const [pool, setPool] = useState<PoolId>("eth-0.1");
  const [mockRelayers, setMockRelayers] = useState<RelayerInfo[]>([]);
  const [relayerId, setRelayerId] = useState<string | null>(null);
  const [gasPriceWei, setGasPriceWei] = useState<bigint | null>(null);
  // the relayers are asked when the Withdraw tab or the relayer settings open — never at page load (the review round of
  // 2026-11-03, C2-7): every listed host had received the IP of every visitor, depositors included, before any notice was shown.
  // Only when a withdrawal is switched on (the tenth review round, C10-15; in the relayer settings too since the eleventh, F11-5): with
  // nothing live every listed host still received the IP of every visitor who opened the Withdraw tab — or the settings, where it had
  // stayed so
  const anyWithdrawLive = POOL_IDS.some((p) => isLive(c, p, "withdraw"));
  useEffect(() => {
    if (route !== "withdraw" && route !== "settings") return;
    if (services && !anyWithdrawLive) return;
    let on = true;
    void source
      .refreshRelayers()
      .then((r) => {
        if (!on) return;
        setMockRelayers(r);
        setRelayerId((id) => id ?? r.find((x) => x.status === "online")?.id ?? null);
      })
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [source, route, services, anyWithdrawLive]);
  // the relayers: the directory's list as the statuses come in (every redraw), the mock's otherwise
  const relayers: RelayerInfo[] = services ? services.relayers.list() : mockRelayers;
  useEffect(() => {
    if (!services) return;
    setRelayerId((id) => id ?? services.relayers.cheapestOnline()?.id ?? null);
  }, [services, version]);

  // the wallet
  const [walletOpen, setWalletOpen] = useState(false);
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const walletState = services?.wallet.state ?? { status: "disconnected" as const };
  const openWallet = async () => {
    if (!services) return;
    setWalletError(null);
    setWalletOpen(true);
    setWallets(await services.wallet.discover());
  };
  // the sanctions oracle, when its switch is on: a read that fails refuses, as the original did (the tenth review round, C10-9 — it had
  // left the wallet connected under "The wallet refused the request.")
  const screen = async (account: string): Promise<"clear" | "listed" | "unavailable"> => {
    if (!services?.rpc) return "unavailable";
    try {
      return (await isSanctioned(services.rpc, account as `0x${string}`)) ? "listed" : "clear";
    } catch {
      return "unavailable";
    }
  };
  const screenedAccount = useRef<string | null>(null);
  const chooseWallet = async (id: string) => {
    if (!services) return;
    setConnecting(true);
    setWalletError(null);
    try {
      const state = await services.wallet.connect(id);
      if (c.complianceOracle && state.status === "connected") {
        const verdict = await screen(state.account);
        if (verdict !== "clear") {
          services.wallet.disconnect();
          setWalletError(t(verdict === "listed" ? "wallet.sanctioned" : "wallet.complianceUnavailable"));
          return;
        }
        screenedAccount.current = state.account;
      }
      setWalletOpen(false);
    } catch {
      setWalletError(t("wallet.rejected"));
    } finally {
      setConnecting(false);
    }
  };
  // every account the wallet switches to is screened too (C10-9): the oracle had been asked at Connect only; the flows ask again at every send
  const connectedAccount = walletState.status === "connected" ? walletState.account : null;
  useEffect(() => {
    if (!services || !c.complianceOracle || !connectedAccount || screenedAccount.current === connectedAccount) return;
    let on = true;
    void screen(connectedAccount).then((verdict) => {
      if (!on) return;
      if (verdict === "clear") {
        screenedAccount.current = connectedAccount;
        return;
      }
      services.wallet.disconnect();
      setWalletError(t(verdict === "listed" ? "wallet.sanctioned" : "wallet.complianceUnavailable"));
      setWalletOpen(true);
    });
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- screen reads the services alone
  }, [services, c.complianceOracle, connectedAccount]);

  // the deposit: a note generated on the device, shown once, dropped when the modal closes (spec §7.11)
  const [note, setNote] = useState<ClassicNote | null>(null);
  const [backedUp, setBackedUp] = useState(false);
  const [copied, setCopied] = useState(false);
  const [depositBusy, setDepositBusy] = useState(false);
  const [depositMessage, setDepositMessage] = useState<string | null>(null);
  // the pool the note was made for (C2-2): the selector stays reachable behind the modal, the deposit goes to this one
  const [notePool, setNotePool] = useState<PoolId>("eth-0.1");
  // the deposit of this note left (a transaction hash exists): Send Deposit gives way to Close (the fourth review round, 2026-11-03 — a
  // second click had asked the wallet to sign the same commitment again, which the pool reverts at the gas of a mainnet transaction)
  const [depositDone, setDepositDone] = useState(false);
  // which note the modal shows (the tenth review round, C10-15): a deposit's answer that arrives after another note was opened had been
  // shown in that note's modal
  const noteSeq = useRef(0);
  const openNote = () => {
    noteSeq.current++;
    setNotePool(pool);
    setNote(generateNote("eth", poolOf(pool).amount, NET_ID, (n) => crypto.getRandomValues(new Uint8Array(n))));
    setBackedUp(false);
    setCopied(false);
    setDepositMessage(null);
    setDepositDone(false);
  };
  const closeNote = () => setNote(null);
  const copyNote = async () => {
    if (!note) return;
    try {
      await navigator.clipboard.writeText(formatNote(note));
      setCopied(true);
    } catch {
      // the browser refused the clipboard: the file remains
    }
  };
  const saveNote = () => note && download(noteFileName(note), formatNote(note));
  const [historyVersion, setHistoryVersion] = useState(0);
  // the modal's facts are the note's pool's (the fourth review round, 2026-11-03): two of its props had read the selector's pool
  const noteRouterDisabled = services?.facts.get(notePool)?.router === "disabled";
  const noteLive = isLive(c, notePool, "deposit");
  // a deposit's words (the tenth review round, C10-4): a receipt not yet arrived is "sent, not confirmed — keep your note", never "did not
  // go through"; a revert says nothing was deposited; only a refusal before the wallet sent anything is "did not go through"
  const depositWords = (job: JobRecord): string =>
    job.state === "COMPLETED"
      ? t("deposit.sent")
      : job.state === "FAILED"
        ? job.failedReason === REVERTED
          ? t("deposit.reverted")
          : t("deposit.failed", { reason: job.failedReason ?? "" })
        : t("deposit.pending");
  const sendDeposit = async () => {
    if (!services || !note || !isLive(c, notePool, "deposit")) return;
    const seq = noteSeq.current;
    setDepositBusy(true);
    setDepositMessage(null);
    try {
      const direct = services.facts.get(notePool)?.router === "disabled";
      const job = await depositFlow(services, { pool: notePool, note, direct, onJob: () => setHistoryVersion((v) => v + 1) });
      if (seq !== noteSeq.current) return; // another note is on screen now: History holds this one's record
      if (job.txHash) setDepositDone(true);
      setDepositMessage(depositWords(job));
    } catch (e) {
      if (seq === noteSeq.current) setDepositMessage(t("deposit.failed", { reason: e instanceof Error ? e.message : "" }));
    } finally {
      setDepositBusy(false);
    }
  };

  // the withdrawal draft
  const [text, setText] = useState("");
  const parsed = useMemo(() => (text.trim() ? parseNote(text) : null), [text]);
  const malformed = parsed !== null && !parsed.ok;
  const [lookup, setLookup] = useState<NoteLookup | null>(null);
  const [checking, setChecking] = useState(false);
  const [spentOnChain, setSpentOnChain] = useState<SpentOnChain | null>(null);
  const [spentAlone, setSpentAlone] = useState(false);
  useEffect(() => {
    setSpentOnChain(null);
    if (!parsed || !parsed.ok) {
      setLookup(null);
      setChecking(false);
      return;
    }
    let on = true;
    setChecking(true);
    void source
      .lookup(parsed.note)
      .then((l) => {
        if (!on) return;
        setLookup(l);
        setChecking(false);
      })
      .catch(() => {
        if (!on) return;
        setLookup(null);
        setChecking(false);
      });
    return () => {
      on = false;
    };
  }, [source, parsed]);
  const [recipient, setRecipient] = useState("");
  const [mode, setMode] = useState<WithdrawMode>("relayer");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // the chain's answer wins over the history's Withdrawal events (the tenth review round, C10-7): "spent" from events nothing verifies had
  // also hidden the one check that asks the pool
  const found = lookup?.kind === "found" && (!lookup.facts.spent || spentOnChain === "unspent") ? lookup : null;
  const relayer = relayers.find((r) => r.id === relayerId) ?? null;
  const liveFees: FeeLines | null = found && relayer && gasPriceWei !== null ? feeLines(poolOf(found.pool), relayer, gasPriceWei) : null;
  // the fee the withdrawal's proof was made with, while its flow runs (the seventh review round, 2026-11-03): the rows had kept re-pricing
  // at the minute's gas price behind the confirmation, and the page said less than the proof pays
  const [flowFees, setFlowFees] = useState<FeeLines | null>(null);
  const fees: FeeLines | null = flowFees ?? liveFees;
  const recipientInvalid = recipient.trim() !== "" && !isAddress(recipient);
  // a well-formed address a withdrawal must not go to (the fourth review round, 2026-11-03): the zero and burn addresses lose it, the pools' own contracts keep it
  const recipientRefused = recipient.trim() !== "" && isAddress(recipient) ? refusedRecipient(recipient) : null;
  const recipientToken = recipientRefused === "token" ? tokenOfRecipient(recipient) : null;
  const withdrawLive = found ? isLive(c, found.pool, "withdraw") : false;
  const historyVerified = found ? (services ? services.histories.get(found.pool)?.verified === true : true) : false;
  // a history an endpoint left unverified for this page is asked again every minute while its note is on screen (the critique of C11-12: one
  // silence had left the Withdraw button disabled for good, under words that promised a check nothing scheduled)
  useEffect(() => {
    const h = found && services?.rpc ? services.histories.get(found.pool) : undefined;
    if (!h || historyVerified) return;
    const timer = setTimeout(() => void h.refresh(), STALE_MS);
    return () => clearTimeout(timer);
  }, [services, found, historyVerified, version]);
  // one withdrawal flow at a time (C2-4): the button had come back the moment the confirmation opened, and a second click meant a
  // second proof and a second submission of the same note
  const [flowRunning, setFlowRunning] = useState(false);
  // a reload is asked first while a deposit's transaction is awaited or a withdrawal's flow runs (the tenth review round, C10-4)
  const inFlight = depositBusy || flowRunning;
  useEffect(() => {
    if (!inFlight) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [inFlight]);
  const canWithdraw =
    !!found &&
    !flowRunning &&
    isAddress(recipient) &&
    recipientRefused === null &&
    historyVerified &&
    (!services || canWithdrawNow(factsOf(services, found.pool), mode)) && // the rows' own verdict (C2-6): the contract, the endpoint, the prover
    (mode === "wallet" ? !services || walletState.status === "connected" : !!relayer && relayer.status !== "offline" && !!fees && fees.receiveWei > 0n);
  // the prover warms up as soon as a live withdrawal is possible: the artifacts fetched and verified, websnark built (spec §7.3)
  useEffect(() => {
    if (found && withdrawLive) void services?.warmProver();
  }, [found, withdrawLive, services]);
  // the note's pool is checked too (C2-6): the availability rows check the selected pool, and a withdrawal's pool is the note's
  useEffect(() => {
    if (found) void services?.checkPool(found.pool);
  }, [found, services]);

  // the flow: the proof in the worker, the confirmation, the relayer's job or the wallet's transaction
  const [proving, setProving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTerms, setConfirmTerms] = useState<ConfirmTerms | null>(null);
  const confirmRef = useRef<((ok: boolean) => void) | null>(null);
  const [flowMessage, setFlowMessage] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  // the gas price again every minute and after a flow's message (C2-5): the fee lines had kept the page's first read, and a refusal
  // against the live minimum ("review the fees again") could not be answered without a reload
  useEffect(() => {
    let on = true;
    void source
      .gasPriceWei()
      .then((g) => on && setGasPriceWei(g))
      .catch(() => on && setGasPriceWei(null));
    return () => {
      on = false;
    };
  }, [source, now, flowMessage]);
  const startWithdrawal = async () => {
    if (flowRunning || !services || !found || !parsed?.ok || !withdrawLive || !isAddress(recipient) || recipientRefused !== null) return;
    setFlowRunning(true);
    setFlowFees(fees);
    setProving(true);
    setFlowMessage(null);
    setSubmitted(false);
    const via = mode;
    const chosen = via === "relayer" ? relayer : null;
    const notePool = found.pool;
    try {
      const job = await withdrawalFlow(services, {
        pool: notePool,
        note: parsed.note,
        facts: found.facts,
        recipient: recipient.trim() as `0x${string}`,
        via,
        relayerId: relayerId ?? undefined,
        feeWei: fees?.totalFeeWei,
        // the confirmation restates what the proof pays, from its own public signals (the tenth review round, C10-1)
        confirm: (terms: ProofTerms) =>
          new Promise<boolean>((resolve) => {
            confirmRef.current = resolve;
            setConfirmTerms({
              pool: notePool,
              recipient: toChecksumAddress(terms.recipient),
              via,
              ...(via === "relayer" && chosen ? { relayerName: chosen.name, relayerAccount: toChecksumAddress(terms.relayer) } : {}),
              feeWei: terms.feeWei,
              receiveWei: poolOf(notePool).denominationWei - terms.feeWei - terms.refundWei,
            });
            setProving(false);
            setConfirmOpen(true);
          }),
        onStep: (s) => {
          if (s.step === "following") setFlowMessage(t("withdraw.following", { state: s.relayerState }));
          if (s.step === "submitting" && via === "relayer") setSubmitted(true); // wallet mode has its own words (the critique)
        },
        onJob: () => setHistoryVersion((v) => v + 1),
      });
      if (job.state === "FAILED") setFlowMessage(t("withdraw.failed", { reason: job.failedKey ? t(job.failedKey) : (job.failedReason ?? "") }));
      else if (job.state === "RECOVERY_REQUIRED")
        // the relayer's answer (C2-3), or the receipt, did not arrive; or the relayer reported FAILED for a note the pool reports spent (C11-13)
        setFlowMessage(
          t(
            job.via === "wallet"
              ? "withdraw.receiptLost"
              : job.relayerState === "FAILED"
                ? job.spentUnread
                  ? "withdraw.failedUnchecked"
                  : "withdraw.failedButSpent"
                : "withdraw.answerLost",
          ),
        );
      else if (job.state === "CANCELLED") setFlowMessage(t("withdraw.cancelled"));
      else if (job.relayerState === "CONFIRMED" && job.state !== "COMPLETED")
        setFlowMessage(t(job.spentUnread ? "withdraw.reportedUnchecked" : "withdraw.reported")); // C10-3; the pool not asked (the critique)
      else if (job.via === "wallet" && job.txHash) setFlowMessage(t("withdraw.sentToWallet"));
    } catch (e) {
      setFlowMessage(t("withdraw.failed", { reason: e instanceof FlowRefused && e.key ? t(e.key) : e instanceof Error ? e.message : "" }));
    } finally {
      setProving(false);
      setFlowRunning(false);
      setFlowFees(null);
      setConfirmOpen(false);
      setConfirmTerms(null);
      confirmRef.current = null;
    }
  };
  const confirm = (ok: boolean) => {
    confirmRef.current?.(ok);
    confirmRef.current = null;
    setConfirmOpen(false);
  };
  const checkSpent = async () => {
    // any deposit found, spent by the history's events or not (C10-7)
    const looked = lookup?.kind === "found" ? lookup : null;
    if (!services?.rpc || !looked || !parsed?.ok) return;
    setSpentOnChain("checking");
    try {
      const derived = await (await services.prover()).note(formatNote(parsed.note));
      if (!derived.ok) throw new Error("the note is not readable");
      // both endpoints, when two are configured (the eleventh review round, C11-12): the first one's word alone had decided "spent". The first is
      // asked alone — its failover had let the second answer for it — and a second that does not answer is said so, never "disagree" (the critique)
      const address = poolOf(looked.pool).address;
      const firstRpc = services.secondOpinion ? (services.firstOpinion ?? services.rpc) : services.rpc;
      // while the pool is held — a relayed withdrawal may still be published — the first endpoint is asked alone (the critique): the second
      // asked the nullifier hash now would tie this page to that withdrawal
      const alone = !!services.secondOpinion && (services.histories.get(looked.pool)?.isHeld() ?? false);
      setSpentAlone(alone);
      const [first, second] = await Promise.all([
        isSpentOnChain(firstRpc, address, derived.nullifierHash).catch(() => null),
        services.secondOpinion && !alone
          ? isSpentOnChain(services.secondOpinion, address, derived.nullifierHash).catch(() => null)
          : Promise.resolve(undefined),
      ]);
      // an endpoint that does not answer is said so, the first one too (the critique): the screen had shown nothing at all
      setSpentOnChain(
        first === null
          ? services.secondOpinion
            ? "first-silent"
            : "rpc-silent"
          : second === null
            ? "silent"
            : second !== undefined && second !== first
              ? "disagree"
              : first
                ? "spent"
                : "unspent",
      );
    } catch {
      setSpentOnChain(null);
    }
  };

  // the statistics follow the selected pool, or the pool of the note being withdrawn (as the original did)
  const statsPool: PoolId = route === "withdraw" && found ? found.pool : pool;
  const [stats, setStats] = useState<{ pool: PoolId; stats: PoolStats } | null>(null);
  useEffect(() => {
    let on = true;
    void source
      .stats(statsPool)
      .then((s) => on && setStats({ pool: statsPool, stats: s }))
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [source, statsPool, historyVersion]);

  const [availability, setAvailability] = useState<Availability | null>(null);
  useEffect(() => {
    let on = true;
    void source
      .availability(pool)
      .then((a) => on && setAvailability(a))
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [source, pool, version]);

  const [history, setHistory] = useState<HistoryRow[]>([]);
  // the records live in this page's memory only when the browser refused its storage (the critique of C11-5): History says so
  const [historyPageOnly, setHistoryPageOnly] = useState(false);
  const [filter, setFilter] = useState<HistoryFilter>("all");
  useEffect(() => {
    if (route !== "history") return;
    let on = true;
    void source
      .history()
      .then((h) => {
        if (!on) return;
        setHistory(h);
        setHistoryPageOnly(source.recordsPageOnly?.() ?? false);
      })
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [source, route, historyVersion]);

  const live: PoolFunctionLive = { deposit: isLive(c, pool, "deposit"), withdraw: isLive(c, pool, "withdraw") };
  const aside =
    route === "deposit" || route === "withdraw" ? <Statistics pool={statsPool} stats={stats?.pool === statsPool ? stats.stats : null} now={now} /> : undefined;

  if (geofenced) {
    return (
      <div className="tc-shell">
        <Notice tone="danger" role="alert" testId="classic-geofenced">
          {t("notice.geofenced")}
        </Notice>
      </div>
    );
  }

  return (
    <Shell
      route={route}
      onRoute={(r) => navigate(r)}
      walletLabel={walletLabel(walletState, services !== null)}
      walletEnabled={services !== null}
      onWallet={() => void openWallet()}
      walletNotice={walletState.status === "wrong-network" ? t("wallet.wrongNetwork") : null}
      prototype={!anyLive(c)}
      aside={aside}
    >
      {route === "deposit" ? (
        <>
          <DepositTab pool={pool} onPool={setPool} onDeposit={openNote} />
          <NoteModal
            open={note !== null}
            note={note ? formatNote(note) : ""}
            fileName={note ? noteFileName(note) : ""}
            backedUp={backedUp}
            onBackedUp={setBackedUp}
            copied={copied}
            onCopy={() => void copyNote()}
            onSave={saveNote}
            live={noteLive && (!services || canDeposit(factsOf(services, notePool)))} // the rows' own verdict (C2-6), of the note's pool
            onSend={() => void sendDeposit()}
            onClose={closeNote}
            directWarning={noteLive && noteRouterDisabled}
            message={depositMessage}
            busy={depositBusy}
            done={depositDone}
          />
        </>
      ) : null}
      {route === "withdraw" ? (
        <WithdrawTab
          text={text}
          onText={setText}
          checking={checking}
          lookup={lookup}
          malformed={malformed}
          now={now}
          recipient={recipient}
          onRecipient={setRecipient}
          recipientInvalid={recipientInvalid}
          recipientRefused={recipientRefused}
          recipientToken={recipientToken}
          locked={flowRunning}
          confirmTerms={confirmTerms}
          donate={c.donationAddress !== null}
          onDonate={() => c.donationAddress && setRecipient(c.donationAddress)}
          mode={mode}
          onMode={setMode}
          relayers={relayers}
          relayerId={relayerId}
          onRelayer={setRelayerId}
          settingsOpen={settingsOpen}
          onToggleSettings={() => setSettingsOpen((o) => !o)}
          fees={fees}
          canWithdraw={canWithdraw}
          live={withdrawLive}
          onWithdraw={() => void startWithdrawal()}
          proving={proving}
          confirmOpen={confirmOpen}
          onConfirm={() => confirm(true)}
          onCancelConfirm={() => confirm(false)}
          submitted={submitted}
          onCheckSpent={services?.rpc ? () => void checkSpent() : undefined}
          spentOnChain={spentOnChain}
          spentAlone={spentAlone}
          historyNotice={found && services && !historyVerified ? t(services.rpc ? "withdraw.historyNotVerified" : "withdraw.historyNoRpc") : null}
          flowMessage={flowMessage}
        />
      ) : null}
      {route === "history" ? (
        <History
          rows={history}
          filter={filter}
          onFilter={setFilter}
          now={now}
          onClear={() => void source.clearHistory().then(() => setHistoryVersion((v) => v + 1))}
          pageOnly={historyPageOnly}
        />
      ) : null}
      {route === "settings" ? (
        <SettingsPage
          rpcUrls={c.rpcUrls}
          relayers={relayers}
          localeChoice={localeChoice}
          onLocale={chooseLocale}
          pool={pool}
          availability={availability}
          live={live}
        />
      ) : null}
      <ConnectModal
        open={walletOpen}
        wallets={wallets.map((w) => ({ id: w.info.id, name: w.info.name, icon: w.info.icon }))}
        state={walletState}
        connecting={connecting}
        error={walletError}
        onChoose={(id) => void chooseWallet(id)}
        onDisconnect={() => {
          services?.wallet.disconnect();
          setWalletOpen(false);
        }}
        onClose={() => setWalletOpen(false)}
      />
    </Shell>
  );
}

/** The clock in seconds: fixed when given, else the device's, ticking every minute (for "Time passed"). */
function useNow(fixed?: number): number {
  const [now, setNow] = useState(() => fixed ?? Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (fixed !== undefined) {
      setNow(fixed);
      return;
    }
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(id);
  }, [fixed]);
  return now;
}

/** The note as a file the browser saves (the original's "Save as a file"): a Blob URL that lives for one click and is
 *  revoked at once — it never enters the history, a log or a request. */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}
