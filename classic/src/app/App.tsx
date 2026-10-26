// The Classic app (V7 Stages 3 and 9): the original interface's one page — Deposit | Withdraw with the Statistics beside
// it — plus History and Settings, over the real services (the chain through the configured endpoints, each pool's
// verified history, the curated relayers, the prover worker, the connected wallet; src/app/services) or the Stage 3 mock
// when a test hands it in. This is the controller: the route, the selected pool, the note shown once and kept in memory
// only, the withdraw draft, the fee lines at the live gas price, the language, the wallet, the two flows. Nothing here
// sends a transaction while a pool function is not live (spec v3.0 §7.7): the sending buttons read "Not connected", the
// banner says so on every screen, and the flows refuse as well.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { config, isLive } from "../config";
import { feeLines } from "../model/fees";
import { isAddress } from "../model/format";
import { mockSource } from "../model/mock";
import { formatNote, generateNote, noteFileName, parseNote, type ClassicNote } from "../model/notes";
import { NET_ID, poolOf, type PoolId } from "../model/pools";
import type { ClassicSource } from "../model/source";
import type { Availability, FeeLines, HistoryRow, NoteLookup, PoolFunctionLive, PoolStats, RelayerInfo, WithdrawMode } from "../model/types";
import { readLocaleChoice, writeLocaleChoice } from "../storage/prefs";
import type { DiscoveredWallet } from "../wallet/injected";
import { ConnectModal, walletLabel } from "../views/Connect";
import { DepositTab, NoteModal } from "../views/Deposit";
import { History, type HistoryFilter } from "../views/History";
import { SettingsPage } from "../views/Settings";
import { Shell } from "../views/Shell";
import { Statistics } from "../views/Statistics";
import { WithdrawTab } from "../views/Withdraw";
import { Notice } from "../views/ui";
import { en } from "./i18n/en";
import { detectLocale, locale, onLocale, setLocale, t, type LocaleChoice } from "./i18n/messages";
import { navigate, useRoute } from "./router";
import { geofenceAnswer, isSanctioned } from "./services/compliance";
import { depositFlow, withdrawalFlow } from "./services/flows";
import { isSpentOnChain } from "../history/spent";
import { createServices, sourceOf, type ClassicServices } from "./services/source";
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
  useEffect(() => {
    let on = true;
    void source
      .relayers()
      .then((r) => {
        if (!on) return;
        setMockRelayers(r);
        setRelayerId((id) => id ?? r.find((x) => x.status === "online")?.id ?? null);
      })
      .catch(() => undefined);
    void source
      .gasPriceWei()
      .then((g) => on && setGasPriceWei(g))
      .catch(() => on && setGasPriceWei(null));
    return () => {
      on = false;
    };
  }, [source]);
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
  const chooseWallet = async (id: string) => {
    if (!services) return;
    setConnecting(true);
    setWalletError(null);
    try {
      const state = await services.wallet.connect(id);
      if (c.complianceOracle && services.rpc && state.status === "connected" && (await isSanctioned(services.rpc, state.account as `0x${string}`))) {
        services.wallet.disconnect();
        setWalletError(t("wallet.sanctioned"));
        return;
      }
      setWalletOpen(false);
    } catch {
      setWalletError(t("wallet.rejected"));
    } finally {
      setConnecting(false);
    }
  };

  // the deposit: a note generated on the device, shown once, dropped when the modal closes (spec §7.11)
  const [note, setNote] = useState<ClassicNote | null>(null);
  const [backedUp, setBackedUp] = useState(false);
  const [copied, setCopied] = useState(false);
  const [depositBusy, setDepositBusy] = useState(false);
  const [depositMessage, setDepositMessage] = useState<string | null>(null);
  const openNote = () => {
    setNote(generateNote("eth", poolOf(pool).amount, NET_ID, (n) => crypto.getRandomValues(new Uint8Array(n))));
    setBackedUp(false);
    setCopied(false);
    setDepositMessage(null);
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
  const routerDisabled = services?.facts.get(pool)?.router === "disabled";
  const sendDeposit = async () => {
    if (!services || !note || !isLive(c, pool, "deposit")) return;
    setDepositBusy(true);
    setDepositMessage(null);
    try {
      const job = await depositFlow(services, { pool, note, direct: routerDisabled, onJob: () => setHistoryVersion((v) => v + 1) });
      setDepositMessage(job.state === "FAILED" ? t("deposit.failed", { reason: job.failedReason ?? "" }) : t("deposit.sent"));
    } catch (e) {
      setDepositMessage(t("deposit.failed", { reason: e instanceof Error ? e.message : "" }));
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
  const [spentOnChain, setSpentOnChain] = useState<"spent" | "unspent" | "checking" | null>(null);
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
  const found = lookup?.kind === "found" && !lookup.facts.spent ? lookup : null;
  const relayer = relayers.find((r) => r.id === relayerId) ?? null;
  const fees: FeeLines | null = found && relayer && gasPriceWei !== null ? feeLines(poolOf(found.pool), relayer, gasPriceWei) : null;
  const recipientInvalid = recipient.trim() !== "" && !isAddress(recipient);
  const withdrawLive = found ? isLive(c, found.pool, "withdraw") : false;
  const historyVerified = found ? (services ? services.histories.get(found.pool)?.verified === true : true) : false;
  const canWithdraw =
    !!found &&
    isAddress(recipient) &&
    historyVerified &&
    (mode === "wallet" ? !services || walletState.status === "connected" : !!relayer && relayer.status !== "offline" && !!fees && fees.receiveWei > 0n);
  // the prover warms up as soon as a live withdrawal is possible: the artifacts fetched and verified, websnark built (spec §7.3)
  useEffect(() => {
    if (found && withdrawLive) void services?.warmProver();
  }, [found, withdrawLive, services]);

  // the flow: the proof in the worker, the confirmation, the relayer's job or the wallet's transaction
  const [proving, setProving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const confirmRef = useRef<((ok: boolean) => void) | null>(null);
  const [flowMessage, setFlowMessage] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const startWithdrawal = async () => {
    if (!services || !found || !parsed?.ok || !withdrawLive || !isAddress(recipient)) return;
    setProving(true);
    setFlowMessage(null);
    setSubmitted(false);
    try {
      const job = await withdrawalFlow(services, {
        pool: found.pool,
        note: parsed.note,
        facts: found.facts,
        recipient: recipient.trim() as `0x${string}`,
        via: mode,
        relayerId: relayerId ?? undefined,
        feeWei: fees?.totalFeeWei,
        confirm: () =>
          new Promise<boolean>((resolve) => {
            confirmRef.current = resolve;
            setProving(false);
            setConfirmOpen(true);
          }),
        onStep: (s) => {
          if (s.step === "following") setFlowMessage(t("withdraw.following", { state: s.relayerState }));
          if (s.step === "submitting") setSubmitted(true);
        },
        onJob: () => setHistoryVersion((v) => v + 1),
      });
      if (job.state === "FAILED") setFlowMessage(t("withdraw.failed", { reason: job.failedReason ?? "" }));
      else if (job.state === "CANCELLED") setFlowMessage(t("withdraw.cancelled"));
      else if (job.via === "wallet" && job.txHash) setFlowMessage(t("withdraw.sentToWallet"));
    } catch (e) {
      setFlowMessage(t("withdraw.failed", { reason: e instanceof Error ? e.message : "" }));
    } finally {
      setProving(false);
      setConfirmOpen(false);
      confirmRef.current = null;
    }
  };
  const confirm = (ok: boolean) => {
    confirmRef.current?.(ok);
    confirmRef.current = null;
    setConfirmOpen(false);
  };
  const checkSpent = async () => {
    if (!services?.rpc || !found || !parsed?.ok) return;
    setSpentOnChain("checking");
    try {
      const derived = await (await services.prover()).note(formatNote(parsed.note));
      if (!derived.ok) throw new Error("the note is not readable");
      setSpentOnChain((await isSpentOnChain(services.rpc, poolOf(found.pool).address, derived.nullifierHash)) ? "spent" : "unspent");
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
  const [filter, setFilter] = useState<HistoryFilter>("all");
  useEffect(() => {
    if (route !== "history") return;
    let on = true;
    void source
      .history()
      .then((h) => on && setHistory(h))
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
            live={live.deposit && (!services || walletState.status === "connected")}
            onSend={() => void sendDeposit()}
            onClose={closeNote}
            directWarning={live.deposit && routerDisabled}
            message={depositMessage}
            busy={depositBusy}
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
          historyNotice={found && services && !historyVerified ? t("withdraw.historyNotVerified") : null}
          flowMessage={flowMessage}
        />
      ) : null}
      {route === "history" ? <History rows={history} filter={filter} onFilter={setFilter} now={now} /> : null}
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
