// Activity's and the detail's states for the screenshot fixtures (spec v2.0 §7.8, §19): the list grouped by day with the
// spec's four rows; an empty list; the detail of an executing ETH → BTC swap with its timeline; the same operation in
// recovery. Static data only.
import { BTC, ETH, USDC, usd } from "../fixtureAmounts";
import type { ActivityModel, DetailModel } from "./View";

export const ACTIVITY_FIXTURES = {
  list: {
    groups: [
      {
        key: "today",
        label: "Today",
        rows: [
          { id: "a1", icon: "swap", title: "ETH → BTC", amount: ETH("3.55"), usdCents: usd("12400"), status: "executing" },
          { id: "a2", icon: "swap", title: "USDC → ETH", amount: USDC("8200"), usdCents: usd("8200"), status: "completed" },
        ],
      },
      {
        key: "yesterday",
        label: "Yesterday",
        rows: [
          { id: "a3", icon: "send", title: "Private Send", amount: USDC("1200"), usdCents: null, status: "completed" },
          { id: "a4", icon: "shield-plus", title: "Protected USDC", amount: USDC("5000"), usdCents: null, status: "completed" },
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
    { label: "Privacy fee", value: { usdCents: usd("124") } },
    { label: "Relayer/network", value: { usdCents: usd("18.40") } },
  ],
  steps: [
    { label: "Quote created", state: "done" },
    { label: "Transaction authorized", state: "done" },
    { label: "Protected execution submitted", state: "done" },
    { label: "Destination settlement", state: "active" },
    { label: "Complete", state: "waiting" },
  ],
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
    steps: executing.steps.map((s) => (s.label === "Destination settlement" ? { ...s, state: "failed" as const } : s)),
  },
  completed: {
    ...executing,
    status: "completed",
    steps: executing.steps.map((s) => ({ ...s, state: "done" as const })),
    canRemove: true,
  },
} satisfies Record<string, DetailModel>;
