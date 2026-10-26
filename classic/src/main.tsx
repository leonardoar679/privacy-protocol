import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
// the design tokens of the Privacy Wallet, copied by scripts/tokens.mjs (one visual identity, spec v3.0 §7.8)
import "./tokens.generated.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
