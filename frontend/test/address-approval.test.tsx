// @vitest-environment happy-dom
// V4 (contract §3.12, §4.5; plan §18–§19): the destination's approval step on the screens — a verified entry out of its
// cooling-off offers "Approve for large payments" in the book and under a typed destination; an approval idle for 90 days
// offers "Check it again" and re-opens the verification; the Immediate override needs no separate approval.
import { describe, it, expect, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { APPROVAL_IDLE_MS, COOLING_OFF_MS } from "@ref/wallet/addressBook";
import { AddressBookPanel, DestinationStatus } from "../src/components/protection/AddressBook";
import { addAddress, approveAddress, destinationCheck, findEntry, verifyAddress } from "../src/wallet/addressBook";
import { session } from "../src/wallet/session";
import { settings } from "../src/wallet/settings";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => { if (root) { act(() => root!.unmount()); root = null; } session.forget(); settings.reset(); });
async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  if (root) act(() => root!.unmount());
  await act(async () => { root = createRoot(container); root.render(node); });
  return container;
}
const EVM = "0x1111111111111111111111111111111111111111";
const button = (c: ParentNode, text: string) => [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

describe("the approval step (V4)", () => {
  it("a verified entry out of its cooling-off is approved by the user in the book; the typed-destination status offers the same", async () => {
    await session.create("a strong password"); session.acknowledgePhrase();
    const added = Date.now() - COOLING_OFF_MS - 60_000; // added long enough ago: the cooling-off has passed
    const e = (addAddress({ chain: "evm", address: EVM, label: "exchange", now: added }) as { entry: { id: string } }).entry;
    verifyAddress(e.id, "groups-read", session, added + 1000);
    expect(destinationCheck("evm", EVM, { tier: "high-value" })).toMatchObject({ ok: false, reason: "unapproved", verified: true });
    const panel = await mount(<AddressBookPanel deployment={null} />);
    const entry = panel.querySelector('[data-testid="book-entry"]')!;
    expect(entry.textContent).toContain("approve it for large payments");
    await act(async () => { (entry.querySelector('[data-testid="approve-entry"]') as HTMLButtonElement).click(); });
    expect(findEntry("evm", EVM)).toMatchObject({ lifecycle: "approved" });
    expect(destinationCheck("evm", EVM, { tier: "high-value" })).toMatchObject({ ok: true });
    expect(panel.querySelector('[data-testid="approve-entry"]')).toBeNull();
    expect(panel.querySelector('[data-testid="book-entry"]')!.getAttribute("data-lifecycle")).toBe("approved");
    // the inline status under a typed destination
    const other = "0x2222222222222222222222222222222222222222";
    const o = (addAddress({ chain: "evm", address: other, now: added }) as { entry: { id: string } }).entry;
    verifyAddress(o.id, "groups-read", session, added + 1000);
    const status = await mount(<DestinationStatus chain="evm" address={other} tier="high-value" masterSeed={session.state().seed!} deployment={null} />);
    expect(status.querySelector('[data-testid="destination-status"]')!.getAttribute("data-reason")).toBe("unapproved");
    await act(async () => { (status.querySelector('[data-testid="approve-destination"]') as HTMLButtonElement).click(); });
    expect(status.querySelector('[data-testid="destination-status"]')!.getAttribute("data-reason")).toBe("");
    expect(status.querySelector('[data-testid="destination-status"]')!.getAttribute("data-ok")).toBe("1");
  });
  it("an approval idle for 90 days is stale: the book and the status offer a re-check that re-opens the verification; a re-check restores the use", async () => {
    await session.create("a strong password"); session.acknowledgePhrase();
    const long = Date.now() - APPROVAL_IDLE_MS - 86_400_000;
    const e = (addAddress({ chain: "evm", address: EVM, label: "treasury", now: long - COOLING_OFF_MS }) as { entry: { id: string } }).entry;
    verifyAddress(e.id, "groups-read", session, long);
    approveAddress(e.id, session, long);
    expect(destinationCheck("evm", EVM, { tier: "high-value" })).toMatchObject({ ok: false, reason: "stale" });
    const panel = await mount(<AddressBookPanel deployment={null} />);
    expect(panel.querySelector('[data-testid="book-entry"]')!.textContent).toContain("check it again");
    await act(async () => { (panel.querySelector('[data-testid="recheck-entry"]') as HTMLButtonElement).click(); });
    expect(panel.querySelector('[data-testid="verify-entry"]'), "the verification re-opens").toBeTruthy();
    const status = await mount(<DestinationStatus chain="evm" address={EVM} tier="high-value" masterSeed={session.state().seed!} deployment={null} />);
    expect(status.querySelector('[data-testid="destination-status"]')!.getAttribute("data-reason")).toBe("stale");
    expect(button(status, "Check it again")).toBeTruthy();
    expect(button(status, "Approve for large payments")).toBeUndefined();
    verifyAddress(e.id, "signed-message", session, Date.now());
    expect(destinationCheck("evm", EVM, { tier: "high-value" })).toMatchObject({ ok: true });
  });
});
