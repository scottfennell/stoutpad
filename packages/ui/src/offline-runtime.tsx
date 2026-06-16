/**
 * The PWA offline runtime: assemble the in-browser App and start it.
 *
 * This is where the offline building blocks are wired into a running app — the
 * counterpart to the server host's `createApp(...)`, but for a no-server,
 * IndexedDB-backed PWA:
 *
 * 1. {@link ensureBrowserRepo} initializes the IndexedDB Git clone on first
 *    launch (idempotent thereafter), seeding a starter note.
 * 2. A {@link BrowserGitEngine} over that clone is the storage backend, exposed
 *    to the **unmodified** {@link App} through the `fetch`-shaped data source
 *    {@link createBrowserApiFetch} — so the App reads/edits notes locally.
 * 3. A {@link createSyncController cadence controller} drives a
 *    {@link createOfflineSyncRunner offline sync runner} off the browser's
 *    focus/online/visibility/timer signals; its conflict notifications are
 *    handed to the App's conflict-toast sink via `onConflicts`.
 *
 * The reconcile-with-a-remote step is intentionally left out: a purely local PWA
 * has no hub, so the runner is a no-op that still exercises the cadence. Wiring a
 * real hub reconcile here is the documented follow-up. See ADR 0011.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { ConflictNotification } from "@stout/core";
import { App } from "./App.js";
import { BrowserGitEngine, ensureBrowserRepo } from "./browser-git-engine.js";
import { createBrowserApiFetch } from "./browser-api.js";
import { createOfflineSyncRunner } from "./offline-sync.js";
import { createSyncController } from "./sync-cadence-controller.js";

/**
 * Boot the offline App into `container`: ensure the IndexedDB repo, wire the
 * in-browser data source and the sync cadence, then render the App. Resolves
 * once the repo is ready and the App has been mounted.
 */
export async function startOfflineApp(container: HTMLElement): Promise<void> {
  await ensureBrowserRepo();
  const engine = new BrowserGitEngine();
  const fetchImpl = createBrowserApiFetch(engine);

  // The App hands us a `notify` handle once mounted; conflict copies produced by
  // a (future) hub reconcile flow through it into the non-blocking toasts.
  let notify: ((notification: ConflictNotification) => void) | null = null;
  const runner = createOfflineSyncRunner({
    notify: (notification) => notify?.(notification),
  });
  // Start the cadence: binds focus/online/visibility + a periodic timer and
  // fires an initial `launch` sync. Lives for the app's lifetime (no teardown).
  createSyncController(runner);

  createRoot(container).render(
    <StrictMode>
      <App fetchImpl={fetchImpl} onConflicts={(fn) => (notify = fn)} />
    </StrictMode>,
  );
}
