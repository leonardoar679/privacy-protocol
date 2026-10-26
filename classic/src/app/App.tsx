// The Classic app (V7 Stage 3): the original interface's one page — Deposit | Withdraw with the Statistics beside it —
// plus History and Settings, over the data behind ClassicSource (the Stage 3 mock; the chain, the verified history and
// the curated relayers from Stages 7–9). This is the controller: the route, the selected pool, the note shown once and
// kept in memory only, the withdraw draft, the fee lines at the source's gas price, the language. Nothing here sends a
// transaction while a pool function is not live (spec v3.0 §7.7): the sending buttons read "Not connected", and the
// banner says so on every screen.
import { useEffect, useMemo, useState } from "react";
import { config, isLive } from "../config";
import { feeLines } from "../model/fees";
import { isAddress } from "../model/format";
import { mockSource } from "../model/mock";
import { formatNote, generateNote, noteFileName, parseNote, type ClassicNote } from "../model/notes";
import { NET_ID, poolOf, type PoolId } from "../model/pools";
import type { ClassicSource } from "../model/source";
import type { Availability, FeeLines, HistoryRow, NoteLookup, PoolFunctionLive, PoolStats, RelayerInfo, WithdrawMode } from "../model/types";
import { readLocaleChoice, writeLocaleChoice } from "../storage/prefs";
import { DepositTab, NoteModal } from "../views/Deposit";
import { History, type HistoryFilter } from "../views/History";
import { SettingsPage } from "../views/Settings";
import { Shell } from "../views/Shell";
import { Statistics } from "../views/Statistics";
import { WithdrawTab } from "../views/Withdraw";
import { en } from "./i18n/en";
import { detectLocale, locale, onLocale, setLocale, t, type LocaleChoice } from "./i18n/messages";
import { navigate, useRoute } from "./router";

/** The words of spec v3.0 §7.7 every build shows until a pool function is switched live (the English catalog's). */
export const NOT_CONNECTED = en["notice.notConnected"];

export interface AppProps {
  /** the data source (the mock when none is given: Stage 3) */
  source?: ClassicSource;
  /** a fixed clock in seconds (the tests'); the device's otherwise, ticking every minute */
  now?: number;
}

export function App(props: AppProps = {}) {
  const c = config();
  const now = useNow(props.now);
  const source = useMemo(() => props.source ?? mockSource({ now: Math.floor(Date.now() / 1000) }), [props.source]);
  const route = useRoute();

  // the language: the stored choice, else the browser's; every change re-renders the tree
  const [, bump] = useState(0);
  useEffect(() => onLocale(() => bump((n) => n + 1)), []);
  const [localeChoice, setLocaleChoice] = useState<LocaleChoice>(() => readLocaleChoice());
  useEffect(() => {
    setLocale(localeChoice === "auto" ? detectLocale(typeof navigator === "undefined" ? undefined : navigator.language) : localeChoice);
    document.documentElement.lang = locale();
  }, [localeChoice]);
  const chooseLocale = (choice: LocaleChoice) => {
    setLocaleChoice(choice);
    writeLocaleChoice(choice);
  };

  // the pool: the original opened on 0.1 ETH
  const [pool, setPool] = useState<PoolId>("eth-0.1");
  const [relayers, setRelayers] = useState<RelayerInfo[]>([]);
  const [relayerId, setRelayerId] = useState<string | null>(null);
  const [gasPriceWei, setGasPriceWei] = useState<bigint | null>(null);
  useEffect(() => {
    let on = true;
    void source.relayers().then((r) => {
      if (!on) return;
      setRelayers(r);
      setRelayerId((id) => id ?? r.find((x) => x.status === "online")?.id ?? null);
    });
    void source.gasPriceWei().then((g) => on && setGasPriceWei(g));
    return () => {
      on = false;
    };
  }, [source]);

  // the deposit: a note generated on the device, shown once, dropped when the modal closes (spec §7.11)
  const [note, setNote] = useState<ClassicNote | null>(null);
  const [backedUp, setBackedUp] = useState(false);
  const [copied, setCopied] = useState(false);
  const openNote = () => {
    setNote(generateNote("eth", poolOf(pool).amount, NET_ID, (n) => crypto.getRandomValues(new Uint8Array(n))));
    setBackedUp(false);
    setCopied(false);
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

  // the withdrawal draft
  const [text, setText] = useState("");
  const parsed = useMemo(() => (text.trim() ? parseNote(text) : null), [text]);
  const malformed = parsed !== null && !parsed.ok;
  const [lookup, setLookup] = useState<NoteLookup | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!parsed || !parsed.ok) {
      setLookup(null);
      setChecking(false);
      return;
    }
    let on = true;
    setChecking(true);
    void source.lookup(parsed.note).then((l) => {
      if (!on) return;
      setLookup(l);
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
  const canWithdraw = !!found && isAddress(recipient) && (mode === "wallet" || (!!relayer && !!fees && fees.receiveWei > 0n));
  const withdrawLive = found ? isLive(c, found.pool, "withdraw") : false;

  // the statistics follow the selected pool, or the pool of the note being withdrawn (as the original did)
  const statsPool: PoolId = route === "withdraw" && found ? found.pool : pool;
  const [stats, setStats] = useState<{ pool: PoolId; stats: PoolStats } | null>(null);
  useEffect(() => {
    let on = true;
    void source.stats(statsPool).then((s) => on && setStats({ pool: statsPool, stats: s }));
    return () => {
      on = false;
    };
  }, [source, statsPool]);

  const [availability, setAvailability] = useState<Availability | null>(null);
  useEffect(() => {
    let on = true;
    setAvailability(null);
    void source.availability(pool).then((a) => on && setAvailability(a));
    return () => {
      on = false;
    };
  }, [source, pool]);

  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [filter, setFilter] = useState<HistoryFilter>("all");
  useEffect(() => {
    if (route !== "history") return;
    let on = true;
    void source.history().then((h) => on && setHistory(h));
    return () => {
      on = false;
    };
  }, [source, route]);

  const live: PoolFunctionLive = { deposit: isLive(c, pool, "deposit"), withdraw: isLive(c, pool, "withdraw") };
  const aside =
    route === "deposit" || route === "withdraw" ? <Statistics pool={statsPool} stats={stats?.pool === statsPool ? stats.stats : null} now={now} /> : undefined;

  return (
    <Shell route={route} onRoute={(r) => navigate(r)} walletLabel={t("wallet.notConnected")} walletEnabled={false} aside={aside}>
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
            live={live.deposit}
            onSend={() => undefined /* Stage 9: the router deposit, behind CLASSIC_LIVE */}
            onClose={closeNote}
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
          onWithdraw={() => undefined /* Stage 9: the proof in the worker, then the relayer or the wallet, behind CLASSIC_LIVE */}
          proving={false}
          confirmOpen={false}
          onConfirm={() => undefined}
          onCancelConfirm={() => undefined}
          submitted={false}
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
