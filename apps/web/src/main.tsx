import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { configureFromBuild } from "./config";
import { startPlatform } from "./platform";
// the design system first (the typeface, the tokens, the base, the components, the patterns — V6), then the legacy
// stylesheet it keeps alive until the screens are rebuilt
import "@privacy-wallet/ui/fonts.css";
import "@privacy-wallet/ui/tokens.css";
import "@privacy-wallet/ui/base.css";
import "@privacy-wallet/ui/components.css";
import "@privacy-wallet/ui/patterns.css";
import "./styles.css";

// the engine's configuration from the build's environment, before anything renders (V6 Stage 3)
configureFromBuild();
// the page's services: the auto-lock and what a lock forgets (V6 Stage 15)
startPlatform();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
