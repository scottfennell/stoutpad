/**
 * `core/token-store` — the secret-at-rest seam for the hub sync **token**.
 *
 * The desktop app authenticates to its **hub** (the remote it clones from and
 * pushes to) with a credential — a Git access token. That token is a secret: it
 * must be encrypted at rest by the OS keychain and **never** logged or written in
 * plaintext. This module is the runtime-agnostic contract for that:
 *
 * - {@link TokenStore} — the narrow get/set/clear surface the hub-sync
 *   orchestrator reads the token from (mirroring the `GitEngine` seam style).
 * - {@link SecureStorage} — the OS encryption seam, shaped to match Electron's
 *   `safeStorage` so the desktop adapter is a near-passthrough. Tests inject a
 *   reversible fake; nothing here imports `electron` or `node`.
 * - {@link SecureFilePorts} — the blob-IO seam (read/write/remove the encrypted
 *   bytes). The Node/Electron side owns the actual filesystem; the pure
 *   {@link createSecureFileTokenStore} composition only ever sees ciphertext.
 *
 * The composition's invariant is the whole point: a token is encrypted **before**
 * it touches disk, and {@link TokenStore.set} refuses to persist at all when
 * encryption is unavailable — there is no plaintext fallback path.
 */

/**
 * Where the hub token is stored and read from. Deliberately tiny — the hub-sync
 * orchestrator only needs to read it (and the desktop UI to set/clear it) — so it
 * can be faked in tests ({@link InMemoryTokenStore}) and backed by the OS keychain
 * in production ({@link createSecureFileTokenStore}).
 */
export interface TokenStore {
  /** The stored token, or `null` when none is stored (or it cannot be read). */
  get(): Promise<string | null>;
  /** Store (replacing any existing) token. */
  set(token: string): Promise<void>;
  /** Remove any stored token. Idempotent when none exists. */
  clear(): Promise<void>;
}

/**
 * A {@link TokenStore} that keeps the token in memory only — the test double and
 * the basis for a "don't persist" mode. Never touches disk or any keychain.
 */
export class InMemoryTokenStore implements TokenStore {
  private token: string | null;

  constructor(initial: string | null = null) {
    this.token = initial;
  }

  async get(): Promise<string | null> {
    return this.token;
  }

  async set(token: string): Promise<void> {
    this.token = token;
  }

  async clear(): Promise<void> {
    this.token = null;
  }
}

/**
 * The OS encryption seam, shaped to match Electron's `safeStorage` so the desktop
 * adapter forwards calls almost verbatim. A platform without a keychain reports
 * {@link isEncryptionAvailable} `false`, and the token is then simply not stored
 * (never written in plaintext).
 */
export interface SecureStorage {
  /** Whether OS-backed encryption is currently available. */
  isEncryptionAvailable(): boolean;
  /** Encrypt a string to opaque bytes (only decryptable on this machine/account). */
  encryptString(plainText: string): Uint8Array;
  /** Decrypt bytes previously produced by {@link encryptString}. */
  decryptString(encrypted: Uint8Array): string;
}

/**
 * The encrypted-blob IO seam. The desktop implements this over a file under the
 * app's user-data directory; the pure {@link createSecureFileTokenStore} only ever
 * hands it ciphertext, so a plaintext token never reaches the filesystem.
 */
export interface SecureFilePorts {
  /** Read the encrypted token blob, or `null` when it is absent. */
  readBlob(): Promise<Uint8Array | null>;
  /** Write (replacing) the encrypted token blob. */
  writeBlob(data: Uint8Array): Promise<void>;
  /** Remove the encrypted token blob. Idempotent when absent. */
  removeBlob(): Promise<void>;
}

/**
 * A {@link TokenStore} that encrypts the token with {@link SecureStorage} and
 * persists only the ciphertext through {@link SecureFilePorts}.
 *
 * Invariants:
 * - {@link TokenStore.set} encrypts first and **throws** when encryption is
 *   unavailable — it never falls back to writing plaintext.
 * - {@link TokenStore.get} returns `null` (rather than throwing) when no blob is
 *   stored or encryption is unavailable, so a missing/locked keychain degrades
 *   sync to unauthenticated rather than crashing the app.
 *
 * Pure but for the two injected seams, mirroring how `writeNote` sits over
 * `WritableGitEngine`.
 */
export function createSecureFileTokenStore(
  secureStorage: SecureStorage,
  ports: SecureFilePorts,
): TokenStore {
  return {
    async get(): Promise<string | null> {
      if (!secureStorage.isEncryptionAvailable()) return null;
      const blob = await ports.readBlob();
      if (blob === null || blob.length === 0) return null;
      return secureStorage.decryptString(blob);
    },

    async set(token: string): Promise<void> {
      if (!secureStorage.isEncryptionAvailable()) {
        throw new Error(
          "secure storage is unavailable; refusing to persist the hub token in plaintext",
        );
      }
      await ports.writeBlob(secureStorage.encryptString(token));
    },

    async clear(): Promise<void> {
      await ports.removeBlob();
    },
  };
}
