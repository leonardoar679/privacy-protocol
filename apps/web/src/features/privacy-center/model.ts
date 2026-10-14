// The Privacy Center's model (spec v2.0 §7.10; doc §36; V6 Stage 14): seven sections — Protection status, Wallet privacy,
// Network privacy, Transaction privacy, Data stored locally, Data sent to services, Advanced settings — every row computed
// from a fact the wallet keeps (the posture, the settings, the address book, the encrypted journal's counts), never
// asserted. "Data sent to services" is generated from the transport's purpose registry (PURPOSES) and the API's field
// list (protocol-types API_OPERATION_FIELDS, pinned to the API's schema), so a new purpose or column cannot go unworded.
// Pure: ./PrivacyCenter.tsx gathers the facts, ./View.tsx renders.
import { API_OPERATION_FIELDS, NEVER_STORED, type ApiFieldGroup, type NeverStored } from "@privacy-wallet/protocol-types";
import { PURPOSES, type Purpose } from "@privacy-wallet/privacy-engine/transport/http";
import type { MessageKey } from "../../app/i18n/en";
import type { CenterLevel, CenterRow, CenterSection, PostureView, PrivacyCenterModel, Tone } from "./View";

export interface CenterFacts {
  posture: PostureView;
  /** the deployment's RPC endpoints, and whether the light client verifies the reads */
  rpcEndpoints: number;
  lightClient: boolean;
  /** private submission: the relayer submits, paid with a private note */
  relayerSubmission: boolean;
  /** no entered destination used in the last 30 days (the address book) */
  freshDestinations: boolean;
  /** the encrypted journal's counts */
  stored: { notes: number; operations: number; addressBook: number };
  /** the purposes this build can use (Private AI only where the build has it) */
  purposes: readonly Purpose[];
  /** the pool's size at the last sync, for the Advanced note */
  poolNotes: number | null;
}

/** The posture's V4 word as the V6 level (spec v2.0 §14.1: the V4 words leave the UI). */
export const levelOf = (overall: PostureView["overall"]): CenterLevel | null =>
  overall === "Excellent" ? "high" : overall === "Good" ? "medium" : overall === "Reduced" ? "low" : null;

/** The purposes a build lists: every named one; `other` is only the transport's default and nothing in the wallet uses it. */
export const listedPurposes = (privateAi: boolean): Purpose[] => PURPOSES.filter((p) => p !== "other" && (privateAi || (p !== "zkapi" && p !== "inference")));

export const PURPOSE_KEY = (p: Purpose): { label: MessageKey; detail: MessageKey } => ({
  label: `privacyCenter.sent.${p}` as MessageKey,
  detail: `privacyCenter.sent.${p}.what` as MessageKey,
});
export const API_GROUP_KEY = (g: ApiFieldGroup): MessageKey => `privacyCenter.apiGroup.${g}` as MessageKey;
export const NEVER_KEY = (n: NeverStored): MessageKey => `privacyCenter.never.${n}` as MessageKey;

const onOff = (on: boolean): { value: MessageKey; tone: Tone } =>
  on ? { value: "privacyCenter.enabled", tone: "ok" } : { value: "privacyCenter.disabled", tone: "warn" };

export function privacyCenterModel(f: CenterFacts): PrivacyCenterModel {
  const level = levelOf(f.posture.overall);
  const privateTransport = f.rpcEndpoints >= 2 && f.lightClient;
  const sections: CenterSection[] = [
    {
      id: "protection",
      title: "privacyCenter.section.protection",
      rows: [
        {
          id: "protection",
          label: "privacyCenter.row.protection",
          value: level ? (`privacyCenter.value.${level}` as MessageKey) : "privacyCenter.unknown",
          tone: level === "low" ? "warn" : level ? "ok" : "neutral",
        },
      ],
      note: "privacyCenter.metadataPublic",
    },
    {
      id: "wallet",
      title: "privacyCenter.section.wallet",
      rows: [
        { id: "walletData", label: "privacyCenter.row.walletData", value: "privacyCenter.value.encryptedLocally", tone: "ok" },
        { id: "analytics", label: "privacyCenter.row.analytics", value: "privacyCenter.off", tone: "ok" },
        { id: "tracking", label: "privacyCenter.row.tracking", value: "privacyCenter.off", tone: "ok" },
      ],
    },
    {
      id: "network",
      title: "privacyCenter.section.network",
      rows: [{ id: "privateTransport", label: "privacyCenter.row.privateTransport", ...onOff(privateTransport) }],
      note: "privacyCenter.networkNote",
    },
    {
      id: "transaction",
      title: "privacyCenter.section.transaction",
      rows: [
        { id: "protectedSource", label: "privacyCenter.row.protectedSource", value: "privacyCenter.value.always", tone: "ok" },
        { id: "privateSubmission", label: "privacyCenter.row.privateSubmission", ...onOff(f.relayerSubmission) },
        { id: "freshDestination", label: "privacyCenter.row.freshDestination", ...onOff(f.freshDestinations) },
      ],
    },
    {
      id: "stored",
      title: "privacyCenter.section.stored",
      rows: [
        { id: "notes", label: "privacyCenter.stored.notes", value: "privacyCenter.value.count", vars: { n: f.stored.notes }, tone: "neutral" },
        { id: "operations", label: "privacyCenter.stored.operations", value: "privacyCenter.value.count", vars: { n: f.stored.operations }, tone: "neutral" },
        {
          id: "addressBook",
          label: "privacyCenter.stored.addressBook",
          value: "privacyCenter.value.count",
          vars: { n: f.stored.addressBook },
          tone: "neutral",
        },
        { id: "settings", label: "privacyCenter.stored.settings", value: "privacyCenter.value.thisDevice", tone: "neutral" },
      ],
      note: "privacyCenter.storedNote",
    },
    {
      id: "sent",
      title: "privacyCenter.section.sent",
      rows: [
        ...f.purposes.map((p): CenterRow => ({ id: `sent:${p}`, label: PURPOSE_KEY(p).label, detail: PURPOSE_KEY(p).detail, tone: "neutral" })),
        {
          id: "apiKeeps",
          label: "privacyCenter.sent.apiKeeps",
          value: "privacyCenter.value.swapsOnly",
          items: (Object.keys(API_OPERATION_FIELDS) as ApiFieldGroup[]).map(API_GROUP_KEY),
          tone: "neutral",
        },
        { id: "never", label: "privacyCenter.sent.never", items: NEVER_STORED.map(NEVER_KEY), tone: "ok" },
      ],
    },
    { id: "advanced", title: "privacyCenter.section.advanced", rows: [], note: "privacyCenter.boundsNote" },
  ];
  return { level, sections, categories: f.posture.categories, overallWord: f.posture.overall, poolNotes: f.poolNotes, limits: f.posture.limits };
}

/** The four lines of "Why?" under a protection indicator (doc §35): each from the assessment, a failed one with its reason. */
export interface WhyLine {
  ok: boolean;
  label: MessageKey;
  reason?: MessageKey;
}
export function whyLines(reasons: readonly string[]): WhyLine[] {
  const has = (r: string) => reasons.includes(r);
  const exec = has("recent") ? "privacyCenter.why.reason.recent" : has("exact-amount") ? "privacyCenter.why.reason.exactAmount" : undefined;
  return [
    { ok: true, label: "privacyCenter.why.source" },
    {
      ok: !has("entered-destination"),
      label: "privacyCenter.why.destination",
      ...(has("entered-destination") ? { reason: "privacyCenter.why.reason.entered" as MessageKey } : {}),
    },
    {
      ok: !has("public-link"),
      label: "privacyCenter.why.provider",
      ...(has("public-link") ? { reason: "privacyCenter.why.reason.publicLink" as MessageKey } : {}),
    },
    { ok: !exec, label: "privacyCenter.why.execution", ...(exec ? { reason: exec as MessageKey } : {}) },
  ];
}
