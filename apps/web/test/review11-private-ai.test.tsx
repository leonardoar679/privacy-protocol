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

/** the note scan's action as the funding's withdrawal found it when it began (the twelfth review round, ZN's critique: the demand made before it) */
const fundSaw = vi.hoisted(() => ({ scan: undefined as { dueAt: number; heldFailures?: number } | null | undefined, at: 0 }));
vi.mock("@privacy-wallet/sdk/privateTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/sdk/privateTx")>()),
  feeTerms: async () => ({ url: "http://relayer.test", info: { feePercentBps: 100 }, fee: { amount: 10n ** 15n, ownerCommitment: 0n, viewPub: new Uint8Array(32), vault: 0n } }),
  privateWithdrawal: async () => {
    const { session: s } = await import("@privacy-wallet/sdk/wallet/session");
    fundSaw.at = Date.now();
    fundSaw.scan = s.journal().schedule.find((a) => a.id === "discovery:pool" && !a.done) ?? null;
    return { txHash: "0x" + "77".repeat(32), proofMs: 1, verifiedLocally: false, spent: [0], submittedBy: "relayer" };
  },
}));

import { getAddress } from "viem";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { scheduleAction } from "@privacy-wallet/sdk/wallet/schedule";
import { PrivateAI } from "../src/components/PrivateAI";
import { Providers } from "../src/app/Providers";

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

describe("the twelfth review round, ZN's critique: Private AI's funding asks for a scan the counters wait on", () => {
  it("the counters waiting on a scan that keeps failing: the funding's withdrawal finds it asked for at once, its failures counted afresh", async () => {
    const ETH_VAULT = getAddress("0x00000000000000000000000000000000000000e7");
    const deployment: Deployment = { chainId: 1, core: getAddress("0x00000000000000000000000000000000000000c0"), ethVault: ETH_VAULT, rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [] };
    await session.create("password-1");
    session.acknowledgePhrase();
    noteStore.add({ note: { vaultId: BigInt(ETH_VAULT), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
    render(
      <Providers deployment={deployment}>
        <PrivateAI masterSeed={session.state().seed!} deployment={deployment} />
      </Providers>,
    );
    const enable = await screen.findByText("Enable private AI");
    await waitFor(() => expect((enable as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(enable);
    });
    const fund = await screen.findByText(/1 · Fund the fresh address from the pool/);
    await waitFor(() => expect((fund as HTMLButtonElement).disabled).toBe(false));
    scheduleAction({ kind: "discovery", orderId: "pool", dueAt: Date.now() + 4 * 60_000, heldFailures: 3 }, session);
    noteStore.holdCounters();
    try {
      await act(async () => {
        fireEvent.click(fund);
      });
      await waitFor(() => expect(fundSaw.scan, "the funding's withdrawal begun").toBeTruthy());
      expect(fundSaw.scan!.dueAt, "already asked for when the withdrawal began").toBeLessThanOrEqual(fundSaw.at);
      expect(fundSaw.scan!.heldFailures ?? 0, "its failures counted afresh").toBe(0);
    } finally {
      noteStore.releaseCounters(0);
      noteStore.clear();
    }
  });
});

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
