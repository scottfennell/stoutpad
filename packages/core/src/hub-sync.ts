/**
 * `core/hub-sync` — the runtime-agnostic orchestration of **hub sync**.
 *
 * Stout is local-first: the desktop app owns a real local Git **working clone**
 * and edits files on disk. The **hub** is the remote that clone is created from
 * and synced against (the server's bare repo, reachable over HTTPS). This module
 * owns the *policy* of that sync, keeping it pure and testable:
 *
 * - The credential maths — {@link authenticateRemoteUrl} injects the access
 *   **token** into an HTTPS remote URL (the `x-access-token:<token>@host`
 *   convention), {@link stripRemoteCredentials} removes it again (so the token is
 *   never persisted into `.git/config`), and {@link redactRemoteUrl} masks it for
 *   safe logging. The token is only ever materialised into a URL at the moment a
 *   Git op runs, never stored alongside the remote.
 * - The clone-then-sync decision — {@link syncWithHub} reads the token from a
 *   {@link TokenStore}, authenticates the URL, and either clones (first run) or
 *   pulls-then-pushes (subsequent runs), driving the narrow
 *   {@link HubRemoteEngine} seam. The actual `git` shelling lives in the Node
 *   engine (`apps/server`); this stays pure so the policy is unit-tested against
 *   an in-memory fake with no network and no real keychain.
 *
 * There is, by design, no plaintext token anywhere in this module's output: it
 * returns only the action it took, and {@link redactRemoteUrl} is the only URL it
 * would ever log.
 */

import type { TokenStore } from "./token-store.js";

/** Default hub branch synced when a {@link HubConfig} does not name one. */
export const DEFAULT_HUB_BRANCH = "main" as const;

/** How to reach the hub: its remote URL and (optionally) the branch to sync. */
export interface HubConfig {
  /** The hub's Git remote URL (HTTPS in production; any Git URL works). */
  remoteUrl: string;
  /** Branch to clone/sync; defaults to {@link DEFAULT_HUB_BRANCH}. */
  branch?: string;
}

/**
 * The remote-Git operations {@link syncWithHub} drives, each taking an already
 * **authenticated** URL (the token, if any, baked in for that single call).
 *
 * Deliberately narrow — just clone / pull / push and a "do I already have a
 * clone?" probe — so the Node side is a thin `git` shell and tests fake it.
 * Implementations must not persist the authenticated URL (e.g. set the remote to
 * the credential-free form after cloning).
 */
export interface HubRemoteEngine {
  /** Whether a local working clone already exists on disk. */
  hasLocalClone(): Promise<boolean>;
  /** Clone the hub into the local workspace using `authenticatedUrl`. */
  cloneFromHub(authenticatedUrl: string, branch: string): Promise<void>;
  /** Pull `branch` from the hub into the local clone using `authenticatedUrl`. */
  pullFromHub(authenticatedUrl: string, branch: string): Promise<void>;
  /** Push the local `branch` to the hub using `authenticatedUrl`. */
  pushToHub(authenticatedUrl: string, branch: string): Promise<void>;
}

/** What {@link syncWithHub} did this run. */
export interface HubSyncResult {
  /** `clone` on the first run (no local clone yet), `sync` thereafter. */
  action: "clone" | "sync";
  /** The branch that was cloned/synced. */
  branch: string;
}

/**
 * Parse `value` as an HTTP(S) URL, or `null` when it is not one.
 *
 * Non-HTTP remotes (SSH `git@…`, `file://`, bare paths) carry no in-URL
 * credentials, so the credential helpers leave them untouched — this is how the
 * offline tests use a local bare-repo path as the "hub".
 */
function tryParseHttpUrl(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
}

/**
 * Return `remoteUrl` with the access `token` injected as HTTP basic-auth userinfo
 * using GitHub's `x-access-token:<token>@host` convention.
 *
 * Any pre-existing credentials are replaced first (so a stale token never
 * lingers), and a `null`/empty token yields the credential-free URL — equivalent
 * to {@link stripRemoteCredentials} — so a public hub or a local-path remote syncs
 * unauthenticated. Non-HTTP URLs are returned unchanged. The token is
 * percent-encoded by the URL serializer, so tokens with reserved characters are
 * safe.
 */
export function authenticateRemoteUrl(remoteUrl: string, token: string | null): string {
  const parsed = tryParseHttpUrl(remoteUrl);
  if (parsed === null) return remoteUrl;
  parsed.username = "";
  parsed.password = "";
  if (token !== null && token !== "") {
    parsed.username = "x-access-token";
    parsed.password = token;
  }
  return parsed.toString();
}

/** Return `remoteUrl` with any embedded credentials removed (HTTP(S) only). */
export function stripRemoteCredentials(remoteUrl: string): string {
  const parsed = tryParseHttpUrl(remoteUrl);
  if (parsed === null) return remoteUrl;
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

/**
 * Return `remoteUrl` safe to log: any embedded credentials are replaced with
 * `***` so a token is never written to a log line. URLs without credentials (and
 * non-HTTP URLs) are returned unchanged.
 */
export function redactRemoteUrl(remoteUrl: string): string {
  const parsed = tryParseHttpUrl(remoteUrl);
  if (parsed === null) return remoteUrl;
  if (parsed.username === "" && parsed.password === "") return parsed.toString();
  parsed.username = "***";
  parsed.password = "";
  return parsed.toString();
}

/**
 * Synchronise the local workspace with the hub, choosing the action by whether a
 * local clone already exists:
 * - **First run** (no local clone) → {@link HubRemoteEngine.cloneFromHub}.
 * - **Subsequent runs** → {@link HubRemoteEngine.pullFromHub} then
 *   {@link HubRemoteEngine.pushToHub} (pull before push so the local clone
 *   integrates remote work before publishing its own).
 *
 * The token is read from `tokenStore` and injected into the URL only here, for the
 * single Git op — it is never returned, logged, or persisted. Pure but for the
 * injected store and engine, mirroring `applyNoteSync`'s orchestrator shape.
 */
export async function syncWithHub(
  engine: HubRemoteEngine,
  tokenStore: TokenStore,
  config: HubConfig,
): Promise<HubSyncResult> {
  const branch = config.branch ?? DEFAULT_HUB_BRANCH;
  const token = await tokenStore.get();
  const url = authenticateRemoteUrl(config.remoteUrl, token);

  if (await engine.hasLocalClone()) {
    await engine.pullFromHub(url, branch);
    await engine.pushToHub(url, branch);
    return { action: "sync", branch };
  }

  await engine.cloneFromHub(url, branch);
  return { action: "clone", branch };
}
