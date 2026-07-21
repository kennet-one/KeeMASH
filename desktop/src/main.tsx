import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { App } from "./App";
import { LocaleProvider } from "./i18n/locale";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider><App /></LocaleProvider>
  </StrictMode>,
);

if ("__TAURI_INTERNALS__" in window) {
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => void invoke("frontend_ready")));
}
