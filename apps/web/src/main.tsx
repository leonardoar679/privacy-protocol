import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
// the design system first (tokens, base, components — V5), then the legacy stylesheet it keeps alive until Stage 10
import "./design-system/tokens.css";
import "./design-system/base.css";
import "./design-system/components.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
