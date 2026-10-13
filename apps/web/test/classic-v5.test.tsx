// @vitest-environment happy-dom
// Classic Privacy on the devnet mock pool (spec §3.14, §16; plan §32–§33; Stage 10): the pools under More, the
// disclosures and the note shown once before a deposit, "I saved my note", the deposit in the journal's optional
// field (never in emptyJournal(), never the notes of the protected balance), a withdrawal prepared against a note —
// the wrong pool's note refused with the reason, a malformed one too, the proof a placeholder until the circuit port —
// and the Advanced rows only under the advanced experience.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { formatNote, generateNote } from "@privacy-wallet/protocol/classic/note";
import { ClassicHome, ClassicPoolScreen, classicDeposits } from "../src/features/classic-privacy/Classic";
import { DEVNET_NET_ID, resetClassicPools } from "../src/features/classic-privacy/mockPool";
import { emptyJournal } from "@privacy-wallet/sdk/wallet/journal";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";

beforeEach(() => resetClassicPools());
afterEach(() => { cleanup(); session.forget(); settings.reset(); });
const type = (el: Element, v: string) => fireEvent.change(el, { target: { value: v } });
const seeded = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff);

describe("Classic Privacy (spec §16)", () => {
  it("More → Classic lists the three devnet pools with their sizes and the separation line; a pool opens", async () => {
    await session.create("pw");
    const open = vi.fn();
    render(<ClassicHome onOpen={open} />);
    expect(screen.getByTestId("classic").textContent).toContain("never your protected balance");
    for (const id of ["eth-0.1", "eth-1", "eth-10"]) expect(screen.getByTestId(`classic-pool-${id}`)).toBeInTheDocument();
    expect(screen.getByTestId("classic-pool-eth-1").textContent).toMatch(/1[,.   ]?027 deposits/);
    expect(screen.getByTestId("classic-pool-eth-1").textContent).toContain("yours: 0");
    fireEvent.click(screen.getByTestId("classic-pool-eth-1"));
    expect(open).toHaveBeenCalledWith("eth-1");
  });

  it("a deposit shows the five disclosures, the note once, needs 'I saved my note', and lands in the journal's optional field — never in emptyJournal(), never among the notes", async () => {
    await session.create("pw");
    render(<ClassicPoolScreen poolId="eth-1" onBack={() => {}} />);
    expect(screen.getByTestId("classic-mine").textContent).toBe("none");
    fireEvent.click(screen.getByTestId("classic-protect"));
    expect(screen.getByTestId("classic-disclosures").querySelectorAll("li")).toHaveLength(5);
    expect(screen.getByTestId("classic-disclosures").textContent).toContain("only key to the deposit");
    expect(screen.queryByTestId("classic-note"), "the note only after the disclosures are accepted").toBeNull();
    expect(screen.getByTestId("classic-deposit-confirm")).toBeDisabled();
    fireEvent.click(screen.getByTestId("classic-agree"));
    const note = screen.getByTestId("classic-note").textContent!;
    expect(note).toMatch(new RegExp(`^tornado-eth-1-${DEVNET_NET_ID}-0x[0-9a-f]{124}$`));
    expect(screen.getByTestId("classic-deposit-confirm"), "the note must be saved first").toBeDisabled();
    fireEvent.click(screen.getByTestId("classic-saved"));
    expect(screen.getByTestId("classic-deposit-confirm")).toBeEnabled();
    fireEvent.click(screen.getByTestId("classic-deposit-confirm"));
    expect(screen.getByTestId("classic-deposited").textContent).toContain("at leaf 1027");
    expect(classicDeposits()).toHaveLength(1);
    expect(session.journal().classic!.deposits[0]).toMatchObject({ poolId: "eth-1", currency: "eth", amount: "1", leafIndex: 1027, status: "ready" });
    expect(session.journal().notes, "the protected balance is untouched").toEqual([]);
    expect("classic" in emptyJournal()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Back to the pool" }));
    expect(screen.getByTestId("classic-mine").textContent).toBe("1 × 1 ETH");
    expect(screen.getByTestId("classic-position").textContent).toMatch(/1[,.   ]?028/); // the pool grew by one
  });

  it("a withdrawal: the wrong pool's note and a malformed one are refused with the reason, the right note prepares a placeholder (the proof arrives with the circuit port); the Advanced rows only under the advanced experience", async () => {
    await session.create("pw");
    render(<ClassicPoolScreen poolId="eth-1" onBack={() => {}} />);
    expect(screen.queryByTestId("classic-advanced"), "Simple hides the roots and relayer detail").toBeNull();
    await act(async () => { settings.set({ advanced: true }); });
    fireEvent.click(screen.getByTestId("classic-advanced-toggle"));
    expect(screen.getByTestId("classic-proof-status").textContent).toBe("proof generation arrives with the circuit port");
    expect(screen.getByTestId("classic-advanced").textContent).toContain("Merkle root");
    fireEvent.click(screen.getByTestId("classic-withdraw"));
    const input = screen.getByTestId("classic-note-input");
    type(input, formatNote(generateNote("eth", "10", DEVNET_NET_ID, seeded)));
    fireEvent.click(screen.getByTestId("classic-prepare"));
    expect(screen.getByTestId("classic-error").textContent).toContain("this pool is the 1 ETH pool");
    type(input, "tornado-eth-1-31337-0x1234");
    fireEvent.click(screen.getByTestId("classic-prepare"));
    expect(screen.getByTestId("classic-error").textContent).toContain("not a classic note");
    type(input, formatNote(generateNote("eth", "1", DEVNET_NET_ID, seeded)));
    type(screen.getByTestId("classic-recipient"), "0x12");
    fireEvent.click(screen.getByTestId("classic-prepare"));
    expect(screen.getByTestId("classic-error").textContent).toContain("0x address");
    type(screen.getByTestId("classic-recipient"), "0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
    fireEvent.click(screen.getByTestId("classic-prepare"));
    expect(screen.queryByTestId("classic-error")).toBeNull();
    expect(screen.getByTestId("classic-withdrawal").getAttribute("data-status")).toBe("proof-pending");
    expect(screen.getByTestId("classic-proof-pending").textContent).toContain("circuit port");
    expect(screen.getByTestId("classic-withdrawal").textContent).toContain("relayer.devnet.local");
    expect(screen.getByTestId("classic-pool").textContent!.toLowerCase()).not.toMatch(/anonymous|mixer|untraceable/);
  });
});
