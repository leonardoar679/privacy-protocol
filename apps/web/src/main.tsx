import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { configureFromBuild } from "./config";
// the design system first (tokens, base, components — V5), then the legacy stylesheet it keeps alive until Stage 10
import "@privacy-wallet/ui/tokens.css";
import "@privacy-wallet/ui/base.css";
import "@privacy-wallet/ui/components.css";
import "./styles.css";

// the engine's configuration from the build's environment, before anything renders (V6 Stage 3)
configureFromBuild();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
