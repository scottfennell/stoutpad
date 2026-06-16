/**
 * Electron-side adapters for the `@stout/core` hub-token seams.
 *
 * This is the only desktop file that touches Electron's `safeStorage` (the OS
 * keychain) and the user-data filesystem. It implements the two pure seams from
 * `core/token-store`:
 *
 * - {@link electronSecureStorage} forwards {@link SecureStorage} to Electron's
 *   `safeStorage` almost verbatim (the seam was shaped to match it). The only
 *   adaptation is decrypt's argument: the seam speaks `Uint8Array`, Electron wants
 *   a `Buffer`, so we wrap with `Buffer.from`.
 * - {@link createFilePorts} implements {@link SecureFilePorts} over a single file
 *   (`hub-token.bin`) under the app's user-data directory. It only ever reads and
 *   writes the **ciphertext** the secure storage produced; a plaintext token never
 *   reaches disk.
 *
 * {@link loadHubConfig} reads the optional hub wiring from the environment, so a
 * desktop build with no hub configured simply runs fully local (no sync).
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safeStorage } from "electron";
import {
  createSecureFileTokenStore,
  type HubConfig,
  type SecureFilePorts,
  type SecureStorage,
  type TokenStore,
} from "@stout/core";

/** File name (under the user-data dir) the encrypted hub token is stored in. */
const TOKEN_FILE_NAME = "hub-token.bin";

/**
 * {@link SecureStorage} backed by Electron's `safeStorage` (OS keychain). The
 * decrypt path bridges the seam's `Uint8Array` to the `Buffer` Electron expects.
 */
export const electronSecureStorage: SecureStorage = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (plainText) => safeStorage.encryptString(plainText),
  decryptString: (encrypted) => safeStorage.decryptString(Buffer.from(encrypted)),
};

/**
 * {@link SecureFilePorts} over the single encrypted-token file at `tokenFilePath`.
 * `readBlob` reports a missing file as `null` (first run), and `removeBlob` is a
 * no-op when absent, so the store is robust to a never-written token.
 */
export function createFilePorts(tokenFilePath: string): SecureFilePorts {
  return {
    async readBlob(): Promise<Uint8Array | null> {
      try {
        return await readFile(tokenFilePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async writeBlob(data: Uint8Array): Promise<void> {
      await mkdir(dirname(tokenFilePath), { recursive: true });
      await writeFile(tokenFilePath, data);
    },
    async removeBlob(): Promise<void> {
      await rm(tokenFilePath, { force: true });
    },
  };
}

/**
 * Build the production {@link TokenStore}: encrypt with the OS keychain, persist
 * only ciphertext to `hub-token.bin` under `userDataDir` (typically
 * `app.getPath("userData")`).
 */
export function createDesktopTokenStore(userDataDir: string): TokenStore {
  return createSecureFileTokenStore(
    electronSecureStorage,
    createFilePorts(join(userDataDir, TOKEN_FILE_NAME)),
  );
}

/**
 * Read the optional hub configuration from the environment:
 * - `STOUT_HUB_URL` — the hub remote to clone/sync against (required to enable
 *   sync; absent/blank ⇒ fully-local desktop, returns `null`).
 * - `STOUT_HUB_BRANCH` — the branch to sync; omitted ⇒ the hub-sync default.
 */
export function loadHubConfig(env: NodeJS.ProcessEnv = process.env): HubConfig | null {
  const remoteUrl = env.STOUT_HUB_URL?.trim();
  if (!remoteUrl) return null;
  const branch = env.STOUT_HUB_BRANCH?.trim();
  return branch ? { remoteUrl, branch } : { remoteUrl };
}
