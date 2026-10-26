// The fixtures entry (spec v2.0 §6, §19): fixtures.html#<id> renders one fixture of ./registry.tsx; fixtures.html alone
// lists them. Built and served by `vite --mode fixtures` only (vite.config.ts); the harness (tests/visual/run.mjs) reads
// the list from window.__PW_FIXTURES__ and waits for [data-fixture-ready]. The sentinel lets apps/web/scripts/
// check-dist.mjs prove that a production build carries none of it.
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "@privacy-wallet/ui/fonts.css";
import "@privacy-wallet/ui/tokens.css";
import "@privacy-wallet/ui/base.css";
import "@privacy-wallet/ui/components.css";
import "@privacy-wallet/ui/patterns.css";
import "../styles.css";
import { configureFromBuild } from "../config";
import { FIXTURES } from "./registry";

export const FIXTURE_SENTINEL = "pw-fixture-sentinel";

// V7 Stage 4: the Settings fixture renders the real sections over the stores at their defaults, and a store's defaults
// read the engine's configuration (the production floors) — configured here as main.tsx does, from the build's environment
configureFromBuild();

declare global {
  interface Window {
    __PW_FIXTURES__?: {
      id: string;
      title: string;
      kind: string;
      simple: boolean;
      keyboard: boolean;
      accept?: string;
      parts: readonly (readonly [string, string])[];
      before?: string;
    }[];
  }
}
window.__PW_FIXTURES__ = FIXTURES.map((f) => ({
  id: f.id,
  title: f.title,
  kind: f.kind,
  simple: !!f.simple,
  keyboard: !!f.keyboard,
  accept: f.accept,
  parts: f.parts ?? [],
  before: f.before,
}));

const current = () => decodeURIComponent(location.hash.slice(1));

function FixtureApp() {
  const [id, setId] = useState(current);
  useEffect(() => {
    const on = () => setId(current());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const fixture = FIXTURES.find((f) => f.id === id);
  if (!fixture) {
    return (
      <main className="ds-preview" data-fixture-ready="index" data-fixture-sentinel={FIXTURE_SENTINEL}>
        <h1>Fixtures</h1>
        <ul>
          {FIXTURES.map((f) => (
            <li key={f.id}>
              <a href={`#${f.id}`}>{f.title}</a>
            </li>
          ))}
        </ul>
      </main>
    );
  }
  return (
    <div data-fixture-ready={fixture.id} data-fixture-sentinel={FIXTURE_SENTINEL}>
      {fixture.render()}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FixtureApp />
  </React.StrictMode>,
);
