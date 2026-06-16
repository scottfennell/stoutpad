/**
 * Electron shell — the **local-first desktop** entry.
 *
 * The desktop app owns a real local Git working clone and runs the very same
 * Stout HTTP API + built `@stout/ui` SPA over it (via `@stout/server/desktop`),
 * loading that loopback URL in a `BrowserWindow`. There is no UI fork and no
 * remote server dependency: the window talks to a host bound on `127.0.0.1`.
 *
 * Boot sequence:
 * 1. Resolve the workspace layout under the app's user-data directory.
 * 2. {@link bootstrapRepo} — if a hub is configured (`STOUT_HUB_URL`), clone/sync
 *    it (token read from the OS keychain); otherwise (or on sync failure) fall
 *    back to a purely-local workspace via {@link ensureWorkspaceRepo}.
 * 3. {@link startLocalWorkspace} over the working clone, then open the window on
 *    its URL.
 *
 * The hub token is never logged or written in plaintext; only the hub-sync
 * *action* and a redacted URL ever surface. See `docs/adr/0010-electron-local-first.md`.
 */

import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { syncWithHub } from "@stout/core";
import {
  ensureWorkspaceRepo,
  loadRepoPaths,
  NodeHubRemoteEngine,
  startLocalWorkspace,
  type LocalWorkspace,
  type RepoPaths,
} from "@stout/server/desktop";
import { createDesktopTokenStore, loadHubConfig } from "./safe-storage.js";

/** The running local host; kept so we can close it cleanly on quit. */
let workspace: LocalWorkspace | null = null;

/**
 * Prepare the local working clone before the host starts.
 *
 * With a hub configured, clone (first run) or pull-then-push (subsequent runs),
 * reading the access token from the OS keychain. If hub sync fails (e.g. offline
 * on first run), fall back to a fully-local workspace so the app still opens — the
 * hub can re-sync on a later launch.
 */
async function bootstrapRepo(paths: RepoPaths): Promise<void> {
  const hub = loadHubConfig();
  if (hub) {
    try {
      const tokenStore = createDesktopTokenStore(app.getPath("userData"));
      const engine = new NodeHubRemoteEngine(paths.cloneDir);
      const result = await syncWithHub(engine, tokenStore, hub);
      console.log(`[stout] hub ${result.action} (branch ${result.branch})`);
      return;
    } catch (err) {
      console.error("[stout] hub sync failed; starting local-only workspace", err);
    }
  }
  await ensureWorkspaceRepo(paths);
}

function createWindow(url: string): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: { contextIsolation: true },
  });
  void win.loadURL(url);
}

app
  .whenReady()
  .then(async () => {
    const dataDir = join(app.getPath("userData"), "workspace");
    const paths = loadRepoPaths({ STOUT_DATA_DIR: dataDir });
    await bootstrapRepo(paths);
    workspace = await startLocalWorkspace({ cloneDir: paths.cloneDir });
    createWindow(workspace.url);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 && workspace) {
        createWindow(workspace.url);
      }
    });
  })
  .catch((err) => {
    console.error("[stout] failed to start desktop workspace", err);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  if (workspace) {
    const closing = workspace;
    workspace = null;
    void closing.close().catch((err) => console.error("[stout] workspace close failed", err));
  }
});
