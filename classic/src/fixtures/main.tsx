// The fixtures entry (spec v3.0 §7.9, §10): fixtures.html#<id> renders one fixture of ./registry.tsx; fixtures.html alone
// lists them. Served by `vite --mode fixtures` only (vite.config.ts); the harness (tests/visual/run.mjs) reads the list
// from window.__TC_FIXTURES__ and waits for [data-fixture-ready]. The sentinel lets scripts/check-dist.mjs prove that a
// build carries none of it.
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "../tokens.generated.css";
import "../styles.css";
import { FIXTURES } from "./registry";

export const FIXTURE_SENTINEL = "tc-fixture-sentinel";

declare global {
  interface Window {
    __TC_FIXTURES__?: { id: string; title: string; locale: string; dialog: boolean }[];
  }
}
window.__TC_FIXTURES__ = FIXTURES.map((f) => ({ id: f.id, title: f.title, locale: f.locale, dialog: !!f.dialog }));

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
      <main className="tc-shell" data-fixture-ready="index" data-fixture-sentinel={FIXTURE_SENTINEL}>
        <h1 className="tc-title">Fixtures</h1>
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
    <div data-fixture-ready={fixture.id} data-fixture-sentinel={FIXTURE_SENTINEL} lang={fixture.locale}>
      {fixture.render()}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FixtureApp />
  </React.StrictMode>,
);
