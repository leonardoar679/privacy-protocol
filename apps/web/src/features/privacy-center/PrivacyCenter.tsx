// The Privacy Center's container (spec v2.0 §7.10; doc §36; V6 Stage 14): the facts the wallet keeps — the posture, the
// settings, the address book, the encrypted journal's counts, the deployment's read endpoints, the pool's size, whether
// this build carries Private AI — gathered into ./model.ts and drawn by ./View.tsx. Nothing is fetched.
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { rpcUrlsOf } from "@privacy-wallet/sdk/rpcUrls";
import { specForChain } from "@privacy-wallet/sdk/lightclient/spec";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { privacyCenterModel, listedPurposes } from "./model";
import { freshDestinations } from "./status";
import { PrivacyCenterView } from "./View";
import { useAddressBook, useAllOperations, useNotes, usePoolStats, usePosture, useSettings } from "../../hooks";

/** Whether this build carries Private AI (its SDK is bundled only then; vite.config.ts defines the flag). */
const privateAi = (): boolean => typeof __ZKAPI__ !== "undefined" && __ZKAPI__;

export function PrivacyCenter({
  deployment,
  onBack,
  onLearnMore,
  onSettings,
  onFees,
  defaultAdvanced = false,
}: {
  deployment: Deployment | null;
  onBack?: () => void;
  onLearnMore?: () => void;
  onSettings?: () => void;
  /** Fees & refunds (V7 Stage 12) */
  onFees?: () => void;
  defaultAdvanced?: boolean;
}) {
  const posture = usePosture(deployment);
  const stats = usePoolStats();
  const s = useSettings();
  const book = useAddressBook();
  const notes = useNotes();
  const operations = useAllOperations();
  const model = privacyCenterModel({
    posture,
    rpcEndpoints: deployment ? rpcUrlsOf(deployment).length : 0,
    lightClient: !!deployment && s.verifyReads && !!specForChain(deployment.chainId),
    relayerSubmission: s.submission.kind === "relayer",
    freshDestinations: freshDestinations(book),
    stored: {
      notes: notes.filter((n) => !n.spent).length,
      operations: operations.length + (session.isUnlocked() ? session.journal().swaps.length : 0),
      addressBook: book.length,
      privateAi: privateAi(),
    },
    purposes: listedPurposes(privateAi()),
    poolNotes: stats ? stats.notes : null,
  });
  return <PrivacyCenterView model={model} actions={{ onBack, onLearnMore, onSettings, onFees }} defaultAdvanced={defaultAdvanced} />;
}
