// @vitest-environment happy-dom
// The eleventh review round (2026-11-04), H11-2 — Private AI's "Withdraw unused credit" journals the next fresh funding address outside React,
// by the opening the close began in: inside a state updater it never ran once the screen had unmounted, the address stayed "funded" and
// current, and the next credit was deposited from it again (two credit notes linked by one address, spec §4, C-L2). The reviewer's probe
// (scratchpad review11/H) became this case; the zkAPI SDK is a stub, the session the real one.
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const st: { resolveWithdraw: (() => void) | null } = { resolveWithdraw: null };
  const client = {
    setWalletProvider: vi.fn(),
    init: vi.fn(async () => {}),
    subscribe: vi.fn(),
    snapshot: () => ({
      initialized: true,
      config: { service: { available: true } },
      wallet: { note: { balance: 1n, expires_at: String(Math.floor(Date.now() / 1000) + 86400) } },
    }),
    withdraw: vi.fn(
      (_kind: string, onStatus: (m: string) => void) =>
        new Promise<void>((resolve) => {
          onStatus("closing…");
          st.resolveWithdraw = resolve;
        }),
    ),
    formatBillingAmount: (x: unknown) => String(x),
    note: null,
    testnetAuthenticated: false,
  };
  return { st, client };
});
vi.mock("../src/zkapi/sdk", () => ({
  CHAT_SPENDING_TIER_USD: [1, 2],
  chatStream: async function* () {},
  configureZkapi: () => {},
  zkapiBundled: true,
  listModels: async () => [],
  loadBrowserConfig: async () => ({
    trusted_deployment: {
      chain_id: 1,
      contract_address: "0x" + "11".repeat(20),
      rpc_url: "http://127.0.0.1:8545",
      protocol_server_url: "https://p.example",
      openrouter_inference_base: "https://openrouter.ai/api/v1",
      deployment_id: "d",
      request_charge_cap: 1,
    },
  }),
  loadPinCheck: async () => ({
    network: "mainnet",
    checkedAt: new Date().toISOString(),
    pass: 1,
    fail: 0,
    deploymentId: "d",
    vault: "0x" + "22".repeat(20),
    circuit: "c",
    protocolServer: "p",
    items: [],
    lab: { pass: 1, fail: 0 },
  }),
  newSessionId: () => "s",
  zkapiClient: h.client,
  zkapiEnabled: () => true,
}));

import { session } from "@privacy-wallet/sdk/wallet/session";
import { PrivateAI } from "../src/components/PrivateAI";

afterEach(() => {
  cleanup();
  session.forget();
  h.st.resolveWithdraw = null;
});

async function enabledAndWithdrawing(): Promise<void> {
  await session.create("password-1");
  session.acknowledgePhrase();
  // the address #0 funded from the pool and its credit deposited earlier (what fundFromPool journals: index 0, funded 0)
  session.update((j) => {
    j.aiFunding = { index: 0, funded: 0 };
  });
  render(<PrivateAI masterSeed={session.state().seed!} deployment={null} />);
  const enable = await screen.findByText("Enable private AI");
  await waitFor(() => expect((enable as HTMLButtonElement).disabled).toBe(false));
  await act(async () => {
    fireEvent.click(enable);
  });
  const withdraw = await screen.findByText("Withdraw unused credit");
  await waitFor(() => expect((withdraw as HTMLButtonElement).disabled).toBe(false));
  await act(async () => {
    fireEvent.click(withdraw);
  });
  await waitFor(() => expect(h.st.resolveWithdraw).not.toBeNull());
}

describe("Private AI's withdrawal advances the funding address (H11-2)", () => {
  it("on the screen: the next fresh address, the funded mark cleared", async () => {
    await enabledAndWithdrawing();
    await act(async () => {
      h.st.resolveWithdraw!();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(session.journal().aiFunding).toEqual({ index: 1 });
  });

  it("the user left the screen while the close ran: the journal advances all the same", async () => {
    await enabledAndWithdrawing();
    cleanup(); // the user navigated away (Home, Activity …): PrivateAIScreen unmounts, the withdrawal goes on
    await act(async () => {
      h.st.resolveWithdraw!();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(h.client.withdraw).toHaveBeenCalled();
    // the credit was withdrawn to address #0: the next one is #1, unfunded — the screen is gone, the journal is not
    expect(session.journal().aiFunding).toEqual({ index: 1 });
  });
});
