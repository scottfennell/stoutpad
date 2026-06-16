import { describe, expect, it } from "vitest";
import {
  createSecureFileTokenStore,
  InMemoryTokenStore,
  type SecureFilePorts,
  type SecureStorage,
} from "./index.js";

/**
 * A reversible fake of the OS keychain: it XOR-masks every byte and frames the
 * result with a marker, so the "ciphertext" is plainly **not** the plaintext (the
 * test asserts the token's bytes never appear verbatim) yet still round-trips.
 */
function createFakeSecureStorage(available = true): SecureStorage {
  const MASK = 0x5a;
  const MARKER = 0x01;
  return {
    isEncryptionAvailable: () => available,
    encryptString(plainText: string): Uint8Array {
      const utf8 = new TextEncoder().encode(plainText);
      const out = new Uint8Array(utf8.length + 1);
      out[0] = MARKER;
      for (let i = 0; i < utf8.length; i += 1) out[i + 1] = utf8[i] ^ MASK;
      return out;
    },
    decryptString(encrypted: Uint8Array): string {
      const body = encrypted.slice(1);
      const utf8 = new Uint8Array(body.length);
      for (let i = 0; i < body.length; i += 1) utf8[i] = body[i] ^ MASK;
      return new TextDecoder().decode(utf8);
    },
  };
}

/** An in-memory {@link SecureFilePorts}, exposing the raw blob for assertions. */
function createMemoryPorts(): SecureFilePorts & { blob: Uint8Array | null } {
  const state: { blob: Uint8Array | null } = { blob: null };
  return {
    get blob() {
      return state.blob;
    },
    async readBlob() {
      return state.blob;
    },
    async writeBlob(data: Uint8Array) {
      state.blob = data;
    },
    async removeBlob() {
      state.blob = null;
    },
  };
}

describe("InMemoryTokenStore", () => {
  it("round-trips set → get and clears", async () => {
    const store = new InMemoryTokenStore();
    expect(await store.get()).toBeNull();

    await store.set("ghp_secret");
    expect(await store.get()).toBe("ghp_secret");

    await store.set("ghp_rotated");
    expect(await store.get()).toBe("ghp_rotated");

    await store.clear();
    expect(await store.get()).toBeNull();
  });

  it("seeds an initial token", async () => {
    expect(await new InMemoryTokenStore("seed").get()).toBe("seed");
  });
});

describe("createSecureFileTokenStore", () => {
  it("encrypts before persisting and decrypts on read", async () => {
    const secure = createFakeSecureStorage();
    const ports = createMemoryPorts();
    const store = createSecureFileTokenStore(secure, ports);

    await store.set("ghp_topsecret");

    // The persisted blob is ciphertext: the token's bytes never appear verbatim.
    expect(ports.blob).not.toBeNull();
    const tokenBytes = new TextEncoder().encode("ghp_topsecret");
    expect(containsSubsequence(ports.blob!, tokenBytes)).toBe(false);

    // …yet it round-trips back to the original token.
    expect(await store.get()).toBe("ghp_topsecret");
  });

  it("refuses to persist (no plaintext fallback) when encryption is unavailable", async () => {
    const ports = createMemoryPorts();
    const store = createSecureFileTokenStore(createFakeSecureStorage(false), ports);

    await expect(store.set("ghp_secret")).rejects.toThrow(/secure storage is unavailable/u);
    // Nothing — encrypted or otherwise — was written to disk.
    expect(ports.blob).toBeNull();
  });

  it("returns null when no blob is stored", async () => {
    const store = createSecureFileTokenStore(createFakeSecureStorage(), createMemoryPorts());
    expect(await store.get()).toBeNull();
  });

  it("returns null (rather than throwing) when encryption is unavailable on read", async () => {
    const ports = createMemoryPorts();
    // Seed a blob via an available store, then read it back through one that is not.
    await createSecureFileTokenStore(createFakeSecureStorage(true), ports).set("ghp_x");
    const locked = createSecureFileTokenStore(createFakeSecureStorage(false), ports);
    expect(await locked.get()).toBeNull();
  });

  it("clears the persisted blob", async () => {
    const ports = createMemoryPorts();
    const store = createSecureFileTokenStore(createFakeSecureStorage(), ports);
    await store.set("ghp_secret");

    await store.clear();

    expect(ports.blob).toBeNull();
    expect(await store.get()).toBeNull();
  });
});

/** Whether `haystack` contains `needle` as a contiguous byte subsequence. */
function containsSubsequence(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}
