import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App.js";
import { resolveRuntimeMode } from "./runtime.js";
import { startOfflineApp } from "./offline-runtime.js";
// The Technical Umber theme. Imported only here (the app entry), never from
// App.tsx, so unit tests run unstyled while the shipped app is fully themed.
import "./styles.css";

// Register the service worker so the app is installable and boots offline.
// `autoUpdate` (vite.config) silently swaps in new builds in the background.
registerSW({ immediate: true });

const container = document.getElementById("root")!;

// One built SPA, two runtimes (ADR 0011). The installed PWA's `start_url` carries
// `?runtime=offline`, booting the server-free IndexedDB backend; the web app
// served at `/` keeps the server-backed `/api/*` runtime, unchanged.
if (resolveRuntimeMode(window.location.search) === "offline") {
  void startOfflineApp(container);
} else {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
