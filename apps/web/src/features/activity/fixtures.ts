// Activity's and the detail's states for the screenshot fixtures (spec v2.0 §7.8, §19): the list grouped by day with the
// spec's four rows; an empty list; the detail of an executing ETH → BTC swap with its timeline; the same operation in
// recovery. Static data only; the words are the catalog's, read when the screen renders (V6 Stage 16: in its locale).
import { BTC, ETH, USDC, usd } from "../fixtureAmounts";
import { t } from "../../app/i18n/messages";
import type { MessageKey } from "../../app/i18n/en";
import type { ActivityModel, DetailModel } from "./View";

type StepState = DetailModel["steps"][number]["state"];
const STEP_KEYS: readonly MessageKey[] = [
  "activity.step.quote",
  "activity.step.authorized",
  "activity.step.submitted",
  "activity.step.settlement",
  "activity.step.complete",
];
/** The timeline's five steps in these states, each labelled by the catalog when it renders. */
const steps = (states: readonly StepState[]) =>
  STEP_KEYS.map((key, i) => ({
    get label() {
      return t(key);
    },
    state: states[i],
  }));

export const ACTIVITY_FIXTURES = {
  list: {
    groups: [
      {
        key: "today",
        get label() {
          return t("activity.today");
        },
        rows: [
          { id: "a1", icon: "swap", title: "ETH → BTC", amount: ETH("3.55"), usdCents: usd("12400"), status: "executing" },
          { id: "a2", icon: "swap", title: "USDC → ETH", amount: USDC("8200"), usdCents: usd("8200"), status: "completed" },
        ],
      },
      {
        key: "yesterday",
        get label() {
          return t("activity.yesterday");
        },
        rows: [
          {
            id: "a3",
            icon: "send",
            get title() {
              return t("operation.title.send");
            },
            amount: USDC("1200"),
            usdCents: null,
            status: "completed",
          },
          {
            id: "a4",
            icon: "shield-plus",
            get title() {
              return t("operation.title.protected", { asset: "USDC" });
            },
            amount: USDC("5000"),
            usdCents: null,
            status: "completed",
          },
        ],
      },
    ],
    refreshing: null,
    advanced: null,
  },
  empty: { groups: [], refreshing: null, advanced: null },
} satisfies Record<string, ActivityModel>;

const executing: DetailModel = {
  id: "swap:0x01",
  title: "ETH → BTC",
  amount: ETH("3.55"),
  usdCents: usd("12400"),
  status: "executing",
  pay: ETH("3.55"),
  receive: { amount: BTC("0.176"), approx: false },
  destination: { label: "bc1q…82c1", verified: true },
  fees: [
    {
      get label() {
        return t("swap.privacyFee");
      },
      value: { usdCents: usd("124") },
    },
    {
      get label() {
        return t("swap.relayerFee");
      },
      value: { usdCents: usd("18.40") },
    },
  ],
  steps: steps(["done", "done", "done", "active", "waiting"]),
  advanced: [
    { label: "Operation ID", value: "swap:0x5fbd…0aa3" },
    { label: "Provider", value: "THORChain" },
    { label: "Settlement state", value: "Destination pending" },
  ],
  canRemove: false,
};

export const DETAIL_FIXTURES = {
  executing,
  recovery: {
    ...executing,
    status: "action-needed",
    steps: steps(["done", "done", "done", "failed", "waiting"]),
  },
  completed: {
    ...executing,
    status: "completed",
    steps: steps(["done", "done", "done", "done", "done"]),
    canRemove: true,
  },
} satisfies Record<string, DetailModel>;
