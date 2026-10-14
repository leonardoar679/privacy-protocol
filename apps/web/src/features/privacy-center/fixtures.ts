// The Privacy Center on fixtures (V6 Stage 14; the screenshot harness and the preview): two fixed view-models over a pool
// of 1,284 notes — "protected" (a relayer, two read endpoints and the light client, fresh destinations) and "entered" (one
// read endpoint, destinations typed by hand). Pure data (a View's lint); test/privacy-center.test.tsx pins both to the
// real model over the real posture, so they cannot drift from what the screen computes.
import type { PrivacyCenterModel } from "./View";

export const PRIVACY_CENTER_FIXTURES: Record<"protected" | "entered", PrivacyCenterModel> = {
  protected: {
    level: "medium",
    sections: [
      {
        id: "protection",
        title: "privacyCenter.section.protection",
        note: "privacyCenter.metadataPublic",
        rows: [{ id: "protection", label: "privacyCenter.row.protection", value: "privacyCenter.value.medium", tone: "ok" }],
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
        note: "privacyCenter.networkNote",
        rows: [{ id: "privateTransport", label: "privacyCenter.row.privateTransport", value: "privacyCenter.enabled", tone: "ok" }],
      },
      {
        id: "transaction",
        title: "privacyCenter.section.transaction",
        rows: [
          { id: "protectedSource", label: "privacyCenter.row.protectedSource", value: "privacyCenter.value.always", tone: "ok" },
          { id: "privateSubmission", label: "privacyCenter.row.privateSubmission", value: "privacyCenter.enabled", tone: "ok" },
          { id: "freshDestination", label: "privacyCenter.row.freshDestination", value: "privacyCenter.enabled", tone: "ok" },
        ],
      },
      {
        id: "stored",
        title: "privacyCenter.section.stored",
        note: "privacyCenter.storedNote",
        rows: [
          { id: "notes", label: "privacyCenter.stored.notes", value: "privacyCenter.value.count", vars: { n: 4 }, tone: "neutral" },
          { id: "operations", label: "privacyCenter.stored.operations", value: "privacyCenter.value.count", vars: { n: 7 }, tone: "neutral" },
          { id: "addressBook", label: "privacyCenter.stored.addressBook", value: "privacyCenter.value.count", vars: { n: 3 }, tone: "neutral" },
          { id: "settings", label: "privacyCenter.stored.settings", value: "privacyCenter.value.thisDevice", tone: "neutral" },
        ],
      },
      {
        id: "sent",
        title: "privacyCenter.section.sent",
        rows: [
          { id: "sent:rpc", label: "privacyCenter.sent.rpc", detail: "privacyCenter.sent.rpc.what", tone: "neutral" },
          { id: "sent:relayer", label: "privacyCenter.sent.relayer", detail: "privacyCenter.sent.relayer.what", tone: "neutral" },
          { id: "sent:swap-service", label: "privacyCenter.sent.swap-service", detail: "privacyCenter.sent.swap-service.what", tone: "neutral" },
          { id: "sent:beacon", label: "privacyCenter.sent.beacon", detail: "privacyCenter.sent.beacon.what", tone: "neutral" },
          { id: "sent:thornode", label: "privacyCenter.sent.thornode", detail: "privacyCenter.sent.thornode.what", tone: "neutral" },
          { id: "sent:artifacts", label: "privacyCenter.sent.artifacts", detail: "privacyCenter.sent.artifacts.what", tone: "neutral" },
          { id: "sent:guest", label: "privacyCenter.sent.guest", detail: "privacyCenter.sent.guest.what", tone: "neutral" },
          {
            id: "apiKeeps",
            label: "privacyCenter.sent.apiKeeps",
            value: "privacyCenter.value.swapsOnly",
            items: [
              "privacyCenter.apiGroup.trade",
              "privacyCenter.apiGroup.order",
              "privacyCenter.apiGroup.progress",
              "privacyCenter.apiGroup.untilSigned",
              "privacyCenter.apiGroup.record",
            ],
            tone: "neutral",
          },
          {
            id: "never",
            label: "privacyCenter.sent.never",
            items: [
              "privacyCenter.never.notes",
              "privacyCenter.never.keys",
              "privacyCenter.never.phrase",
              "privacyCenter.never.witnesses",
              "privacyCenter.never.balances",
              "privacyCenter.never.address",
              "privacyCenter.never.ip",
              "privacyCenter.never.user-agent",
              "privacyCenter.never.funding-transaction",
            ],
            tone: "ok",
          },
        ],
      },
      {
        id: "advanced",
        title: "privacyCenter.section.advanced",
        note: "privacyCenter.boundsNote",
        rows: [],
      },
    ],
    categories: [
      {
        id: "financial",
        label: "Financial history",
        score: 86,
        level: "Excellent",
        why: [
          "The pool holds 1284 notes; with bucketed amounts and your delay window the effective set is about 369.",
          "Private transfers inside the pool show nothing but a transaction; only what leaves it has a public side.",
        ],
      },
      {
        id: "addresses",
        label: "Address separation",
        score: 90,
        level: "Excellent",
        why: [
          "Every withdrawal, swap and receipt uses a fresh address of this wallet; your privacy address is shared only with people who pay you.",
          "An address you type by hand is yours to keep separate: the wallet warns when it is reused.",
        ],
      },
      {
        id: "network",
        label: "Network privacy",
        score: 75,
        level: "Good",
        why: [
          "A relayer submits your private transactions and is paid by a private fee note; your address never sends them.",
          "The relayer still sees your IP address (the web build cannot hide it).",
        ],
      },
      {
        id: "rpc",
        label: "RPC privacy",
        score: 80,
        level: "Good",
        why: [
          "2 endpoints answer every read and must agree; none is trusted alone.",
          "An Ethereum light client proves the pool before every transaction.",
          "Every endpoint sees the same requests for every user, and your IP address.",
        ],
      },
      {
        id: "timing",
        label: "Timing privacy",
        score: 83,
        level: "Good",
        why: ["Swaps are funded at a random moment inside 1 h–24 h; a patient observer still sees when money moves."],
      },
      {
        id: "crossChain",
        label: "Cross-chain privacy",
        score: 70,
        level: "Good",
        why: [
          "A swap pays from a one-time escrow to a fresh address of this wallet; the provider sees the escrow, the destination and the amount, never your permanent address.",
          "The route is chosen by its privacy score among live quotes; the Swap screen shows the level of the chosen one.",
        ],
      },
    ],
    overallWord: "Good",
    poolNotes: 1284,
    limits: [
      "Adding funds is public by design: the deposit shows your address and its amount; privacy starts with what happens after it.",
      "Your IP address is visible to the RPC endpoints and to the relayer; a native app with Tor or a light client is the upgrade.",
      "A swap provider sees the one-time deposit address, the destination and the amount, and some publish that link; your private source stays protected, but timing and amount can be correlated by a patient observer.",
      "The pool is the crowd you hide in: with few notes, or an unusual amount, the effective set is small and the numbers here say so.",
      "Every action here leaves some public trace by construction. Every score is a bound from the privacy lab, not a guarantee.",
    ],
  },
  entered: {
    level: "low",
    sections: [
      {
        id: "protection",
        title: "privacyCenter.section.protection",
        note: "privacyCenter.metadataPublic",
        rows: [{ id: "protection", label: "privacyCenter.row.protection", value: "privacyCenter.value.low", tone: "warn" }],
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
        note: "privacyCenter.networkNote",
        rows: [{ id: "privateTransport", label: "privacyCenter.row.privateTransport", value: "privacyCenter.disabled", tone: "warn" }],
      },
      {
        id: "transaction",
        title: "privacyCenter.section.transaction",
        rows: [
          { id: "protectedSource", label: "privacyCenter.row.protectedSource", value: "privacyCenter.value.always", tone: "ok" },
          { id: "privateSubmission", label: "privacyCenter.row.privateSubmission", value: "privacyCenter.enabled", tone: "ok" },
          { id: "freshDestination", label: "privacyCenter.row.freshDestination", value: "privacyCenter.disabled", tone: "warn" },
        ],
      },
      {
        id: "stored",
        title: "privacyCenter.section.stored",
        note: "privacyCenter.storedNote",
        rows: [
          { id: "notes", label: "privacyCenter.stored.notes", value: "privacyCenter.value.count", vars: { n: 4 }, tone: "neutral" },
          { id: "operations", label: "privacyCenter.stored.operations", value: "privacyCenter.value.count", vars: { n: 7 }, tone: "neutral" },
          { id: "addressBook", label: "privacyCenter.stored.addressBook", value: "privacyCenter.value.count", vars: { n: 3 }, tone: "neutral" },
          { id: "settings", label: "privacyCenter.stored.settings", value: "privacyCenter.value.thisDevice", tone: "neutral" },
        ],
      },
      {
        id: "sent",
        title: "privacyCenter.section.sent",
        rows: [
          { id: "sent:rpc", label: "privacyCenter.sent.rpc", detail: "privacyCenter.sent.rpc.what", tone: "neutral" },
          { id: "sent:relayer", label: "privacyCenter.sent.relayer", detail: "privacyCenter.sent.relayer.what", tone: "neutral" },
          { id: "sent:swap-service", label: "privacyCenter.sent.swap-service", detail: "privacyCenter.sent.swap-service.what", tone: "neutral" },
          { id: "sent:beacon", label: "privacyCenter.sent.beacon", detail: "privacyCenter.sent.beacon.what", tone: "neutral" },
          { id: "sent:thornode", label: "privacyCenter.sent.thornode", detail: "privacyCenter.sent.thornode.what", tone: "neutral" },
          { id: "sent:artifacts", label: "privacyCenter.sent.artifacts", detail: "privacyCenter.sent.artifacts.what", tone: "neutral" },
          { id: "sent:guest", label: "privacyCenter.sent.guest", detail: "privacyCenter.sent.guest.what", tone: "neutral" },
          {
            id: "apiKeeps",
            label: "privacyCenter.sent.apiKeeps",
            value: "privacyCenter.value.swapsOnly",
            items: [
              "privacyCenter.apiGroup.trade",
              "privacyCenter.apiGroup.order",
              "privacyCenter.apiGroup.progress",
              "privacyCenter.apiGroup.untilSigned",
              "privacyCenter.apiGroup.record",
            ],
            tone: "neutral",
          },
          {
            id: "never",
            label: "privacyCenter.sent.never",
            items: [
              "privacyCenter.never.notes",
              "privacyCenter.never.keys",
              "privacyCenter.never.phrase",
              "privacyCenter.never.witnesses",
              "privacyCenter.never.balances",
              "privacyCenter.never.address",
              "privacyCenter.never.ip",
              "privacyCenter.never.user-agent",
              "privacyCenter.never.funding-transaction",
            ],
            tone: "ok",
          },
        ],
      },
      {
        id: "advanced",
        title: "privacyCenter.section.advanced",
        note: "privacyCenter.boundsNote",
        rows: [],
      },
    ],
    categories: [
      {
        id: "financial",
        label: "Financial history",
        score: 86,
        level: "Excellent",
        why: [
          "The pool holds 1284 notes; with bucketed amounts and your delay window the effective set is about 369.",
          "Private transfers inside the pool show nothing but a transaction; only what leaves it has a public side.",
        ],
      },
      {
        id: "addresses",
        label: "Address separation",
        score: 40,
        level: "Reduced",
        why: ["Destinations are entered by hand: whoever knows an address knows the payments to it."],
      },
      {
        id: "network",
        label: "Network privacy",
        score: 75,
        level: "Good",
        why: [
          "A relayer submits your private transactions and is paid by a private fee note; your address never sends them.",
          "The relayer still sees your IP address (the web build cannot hide it).",
        ],
      },
      {
        id: "rpc",
        label: "RPC privacy",
        score: 35,
        level: "Reduced",
        why: [
          "One endpoint serves every read and could lie or watch; configure two or more.",
          "An Ethereum light client proves the pool before every transaction.",
          "Every endpoint sees the same requests for every user, and your IP address.",
        ],
      },
      {
        id: "timing",
        label: "Timing privacy",
        score: 83,
        level: "Good",
        why: ["Swaps are funded at a random moment inside 1 h–24 h; a patient observer still sees when money moves."],
      },
      {
        id: "crossChain",
        label: "Cross-chain privacy",
        score: 70,
        level: "Good",
        why: [
          "A swap pays from a one-time escrow to a fresh address of this wallet; the provider sees the escrow, the destination and the amount, never your permanent address.",
          "The route is chosen by its privacy score among live quotes; the Swap screen shows the level of the chosen one.",
        ],
      },
    ],
    overallWord: "Reduced",
    poolNotes: 1284,
    limits: [
      "Adding funds is public by design: the deposit shows your address and its amount; privacy starts with what happens after it.",
      "Your IP address is visible to the RPC endpoints and to the relayer; a native app with Tor or a light client is the upgrade.",
      "A swap provider sees the one-time deposit address, the destination and the amount, and some publish that link; your private source stays protected, but timing and amount can be correlated by a patient observer.",
      "The pool is the crowd you hide in: with few notes, or an unusual amount, the effective set is small and the numbers here say so.",
      "Every action here leaves some public trace by construction. Every score is a bound from the privacy lab, not a guarantee.",
    ],
  },
};
