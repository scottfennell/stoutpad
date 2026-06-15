/**
 * Minimal Electron shell for the walking skeleton.
 *
 * For this slice it simply loads the server-hosted UI in a window, proving the
 * same React shell can run inside Electron. The local-first Git adapter wiring
 * lands in a later slice (issue: "Electron desktop (local-first)").
 */
import { app, BrowserWindow } from "electron";

const SERVER_URL = process.env.STOUT_SERVER_URL ?? "http://localhost:3000";

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: { contextIsolation: true },
  });
  void win.loadURL(SERVER_URL);
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
