// Receive (plan §46; whale spec §21): the wallet's privacy address for pool payments, and fresh per-asset addresses
// (Bitcoin / Solana / EVM) from the Chain Key Abstraction — a new one on demand, each meant to be used once, so the
// permanent public address never has to be shown. The QR and the address, with the destination card beside them:
// the QR alone is never the confirmation. The address book says when a fresh address was used.
import { useEffect, useState } from "react";
import type { ChainAccount, ChainKind } from "@privacy-wallet/protocol/wallet/chainKeys";
import { Button, Page, Segmented } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { privacyAddress } from "@privacy-wallet/sdk/privateTx";
import { consumeFreshAddress, lastUnusedFreshAddress } from "@privacy-wallet/sdk/keys/chainKeys";
import { findEntry } from "@privacy-wallet/sdk/wallet/addressBook";
import { discoverSoon } from "@privacy-wallet/sdk/wallet/discovery";
import { DestinationCard } from "../../components/DestinationCard";
import { QrCode } from "../../components/QrCode";
import { unsavedAddressWords } from "../destinationWords";
import { useAddressBook } from "../../hooks";

type Kind = "private-eth" | "bitcoin" | "solana" | "evm";
const CHAIN: Record<Kind, ChainKind | null> = { "private-eth": null, bitcoin: "bitcoin", solana: "solana", evm: "evm" };


export function Receive({ masterSeed, onBack }: { masterSeed: Uint8Array; onBack?: () => void }) {
  const t = useT();
  const [kind, setKind] = useState<Kind>("private-eth");
  const [shown, setShown] = useState<Partial<Record<ChainKind, ChainAccount>>>({});
  const [copied, setCopied] = useState(false);
  const [unsaved, setUnsaved] = useState("");
  useAddressBook();
  // a V6 follow-up: whoever shows the address to be paid looks for the transfer — a scan now (at most once a minute),
  // then every ten minutes; a first launch stays request-free (spec v2.0 §10) until the wallet holds something
  useEffect(() => {
    discoverSoon();
  }, []);
  const chain = CHAIN[kind];
  // the last reserved address only while nothing has used it (the sixth review round, 2026-11-03): a consumed one is not offered again
  const current = chain ? shown[chain] ?? lastUnusedFreshAddress(masterSeed, chain) : null;
  const address = chain ? current?.address ?? "" : privacyAddress(masterSeed);
  const entry = chain && current ? findEntry(chain, current.address) : null;
  const spent = !!entry && (entry.lifecycle === "used" || entry.lifecycle === "settled" || entry.lifecycle === "retired");
  const note = kind === "private-eth" ? t("receive.notePrivate") : kind === "bitcoin" ? t("receive.noteBitcoin") : kind === "solana" ? t("receive.noteSolana") : t("receive.noteEvm");
  const network = kind === "bitcoin" ? t("receive.networkBitcoin") : kind === "solana" ? t("receive.networkSolana") : kind === "evm" ? t("receive.networkEvm") : t("receive.networkPool");
  const assetName = kind === "bitcoin" ? "BTC" : kind === "solana" ? "SOL" : "ETH";

  function generate() {
    if (!chain) return;
    // never an address the journal cannot keep (audit round 2, n48): it would be handed out again after the next lock
    let acct: ChainAccount;
    try {
      acct = consumeFreshAddress(masterSeed, chain);
    } catch (e) {
      const words = unsavedAddressWords(e);
      if (!words) throw e;
      setUnsaved(t(words));
      return;
    }
    setUnsaved("");
    setShown((s) => ({ ...s, [chain]: acct }));
    setCopied(false);
  }
  async function copy() {
    try { await navigator.clipboard?.writeText(address); setCopied(true); } catch { setCopied(false); }
  }

  return (
    <Page title={t("route.receive")} back={onBack} testId="sheet-receive">
      <div className="ds-stack" data-testid="receive">
        <Segmented value={kind} onChange={(v) => { setKind(v as Kind); setCopied(false); }} ariaLabel={t("receive.asset")} name="receive-kind"
          options={[{ value: "private-eth", label: t("receive.privateEth"), testId: "receive-private" }, { value: "bitcoin", label: t("receive.bitcoin"), testId: "receive-bitcoin" }, { value: "solana", label: t("receive.solana"), testId: "receive-solana" }, { value: "evm", label: t("receive.evm"), testId: "receive-evm" }]} />
        <p className="ds-note">{note}</p>
        {address ? (
          <>
            <div className="ds-receive">
              <QrCode text={address} testId="receive-qr" />
              <div className="ds-receive-main ds-stack-sm">
                <code className="ds-mono-break" data-testid="receive-address">{address}</code>
                {current ? <p className="ds-note">{t("receive.fresh", { n: current.index + 1 })}{spent ? ` · ${t("receive.usedOnce")}` : ""}</p> : null}
                {spent ? <p className="ds-note-warn" data-testid="address-used">{t("receive.used")}</p> : null}
                <div className="ds-actions">
                  <Button variant="secondary" onClick={() => void copy()} icon="copy" data-testid="receive-copy">{copied ? t("receive.copied") : t("receive.copy")}</Button>
                  {chain ? <Button variant="secondary" onClick={generate} icon="refresh" data-testid="receive-new">{t("receive.new")}</Button> : null}
                </div>
              </div>
            </div>
            <DestinationCard title={t("receive.yourAddress")} network={network} asset={assetName} address={address} kind={chain ? "fresh" : "privacy-address"} />
          </>
        ) : (
          <Button size="lg" full onClick={generate} data-testid="receive-generate">{t("receive.generate")}</Button>
        )}
        {unsaved ? <p className="ds-note-warn" data-testid="receive-unsaved">{unsaved}</p> : null}
      </div>
    </Page>
  );
}
