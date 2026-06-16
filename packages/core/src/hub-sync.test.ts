import { describe, expect, it } from "vitest";
import {
  authenticateRemoteUrl,
  DEFAULT_HUB_BRANCH,
  InMemoryTokenStore,
  redactRemoteUrl,
  stripRemoteCredentials,
  syncWithHub,
  type HubRemoteEngine,
} from "./index.js";

/**
 * In-memory {@link HubRemoteEngine}: records every call (and the URL it was given)
 * so the orchestrator's clone-vs-sync decision and token injection are asserted
 * without touching real Git.
 */
class FakeHubRemoteEngine implements HubRemoteEngine {
  readonly ops: Array<{ op: string; url: string; branch: string }> = [];

  constructor(private cloned: boolean) {}

  async hasLocalClone(): Promise<boolean> {
    return this.cloned;
  }

  async cloneFromHub(authenticatedUrl: string, branch: string): Promise<void> {
    this.ops.push({ op: "clone", url: authenticatedUrl, branch });
    this.cloned = true;
  }

  async pullFromHub(authenticatedUrl: string, branch: string): Promise<void> {
    this.ops.push({ op: "pull", url: authenticatedUrl, branch });
  }

  async pushToHub(authenticatedUrl: string, branch: string): Promise<void> {
    this.ops.push({ op: "push", url: authenticatedUrl, branch });
  }
}

describe("authenticateRemoteUrl", () => {
  it("injects the token as x-access-token userinfo on an HTTPS URL", () => {
    expect(authenticateRemoteUrl("https://hub.example.com/me/notes.git", "ghp_abc")).toBe(
      "https://x-access-token:ghp_abc@hub.example.com/me/notes.git",
    );
  });

  it("replaces any pre-existing credentials rather than stacking them", () => {
    expect(
      authenticateRemoteUrl("https://old:stale@hub.example.com/me/notes.git", "ghp_new"),
    ).toBe("https://x-access-token:ghp_new@hub.example.com/me/notes.git");
  });

  it("strips credentials when the token is null or empty", () => {
    expect(
      authenticateRemoteUrl("https://x-access-token:tok@hub.example.com/r.git", null),
    ).toBe("https://hub.example.com/r.git");
    expect(authenticateRemoteUrl("https://hub.example.com/r.git", "")).toBe(
      "https://hub.example.com/r.git",
    );
  });

  it("percent-encodes a token with reserved characters", () => {
    const url = authenticateRemoteUrl("https://hub.example.com/r.git", "a/b@c:d");
    expect(url).toContain("x-access-token:a%2Fb%40c%3Ad@hub.example.com");
    // The raw, unencoded secret never appears in the URL.
    expect(url).not.toContain("a/b@c:d");
  });

  it("leaves non-HTTP remotes (ssh, file, bare paths) untouched", () => {
    expect(authenticateRemoteUrl("git@github.com:me/notes.git", "ghp_abc")).toBe(
      "git@github.com:me/notes.git",
    );
    expect(authenticateRemoteUrl("/tmp/hub.git", "ghp_abc")).toBe("/tmp/hub.git");
  });
});

describe("stripRemoteCredentials", () => {
  it("removes embedded credentials from an HTTPS URL", () => {
    expect(
      stripRemoteCredentials("https://x-access-token:tok@hub.example.com/r.git"),
    ).toBe("https://hub.example.com/r.git");
  });

  it("is a no-op on credential-free and non-HTTP URLs", () => {
    expect(stripRemoteCredentials("https://hub.example.com/r.git")).toBe(
      "https://hub.example.com/r.git",
    );
    expect(stripRemoteCredentials("/tmp/hub.git")).toBe("/tmp/hub.git");
  });
});

describe("redactRemoteUrl", () => {
  it("masks the token so it never reaches a log line", () => {
    const redacted = redactRemoteUrl("https://x-access-token:ghp_secret@hub.example.com/r.git");
    expect(redacted).toBe("https://***@hub.example.com/r.git");
    expect(redacted).not.toContain("ghp_secret");
  });

  it("leaves credential-free and non-HTTP URLs unchanged", () => {
    expect(redactRemoteUrl("https://hub.example.com/r.git")).toBe(
      "https://hub.example.com/r.git",
    );
    expect(redactRemoteUrl("/tmp/hub.git")).toBe("/tmp/hub.git");
  });
});

describe("syncWithHub", () => {
  const remoteUrl = "https://hub.example.com/me/notes.git";

  it("clones on the first run (no local clone yet), injecting the token", async () => {
    const engine = new FakeHubRemoteEngine(false);
    const tokens = new InMemoryTokenStore("ghp_abc");

    const result = await syncWithHub(engine, tokens, { remoteUrl });

    expect(result).toEqual({ action: "clone", branch: "main" });
    expect(engine.ops).toEqual([
      {
        op: "clone",
        url: "https://x-access-token:ghp_abc@hub.example.com/me/notes.git",
        branch: "main",
      },
    ]);
  });

  it("pulls then pushes on subsequent runs (clone already present)", async () => {
    const engine = new FakeHubRemoteEngine(true);
    const tokens = new InMemoryTokenStore("ghp_abc");

    const result = await syncWithHub(engine, tokens, { remoteUrl });

    expect(result).toEqual({ action: "sync", branch: "main" });
    expect(engine.ops.map((o) => o.op)).toEqual(["pull", "push"]);
    for (const op of engine.ops) {
      expect(op.url).toBe("https://x-access-token:ghp_abc@hub.example.com/me/notes.git");
    }
  });

  it("syncs unauthenticated when no token is stored", async () => {
    const engine = new FakeHubRemoteEngine(false);

    await syncWithHub(engine, new InMemoryTokenStore(null), { remoteUrl });

    // No credentials are injected — the bare URL is used.
    expect(engine.ops[0].url).toBe(remoteUrl);
  });

  it("honours an explicit branch and defaults to the hub default otherwise", async () => {
    const onBranch = new FakeHubRemoteEngine(false);
    await syncWithHub(onBranch, new InMemoryTokenStore("t"), {
      remoteUrl,
      branch: "trunk",
    });
    expect(onBranch.ops[0].branch).toBe("trunk");

    const onDefault = new FakeHubRemoteEngine(false);
    await syncWithHub(onDefault, new InMemoryTokenStore("t"), { remoteUrl });
    expect(onDefault.ops[0].branch).toBe(DEFAULT_HUB_BRANCH);
  });
});
