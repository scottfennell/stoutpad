# 10. Electron desktop (local-first)

- Status: Accepted
- Date: 2026-06-16
- Issue: #12 (Electron desktop (local-first))

## Context

Every slice so far (ADR 0001–0009) built the product as a web app: an Express
host (`apps/server`) bootstraps Postgres, runs migrations, and serves the built
`@stout/ui` SPA, which talks to it over `/api/*`. The Electron shell
(`apps/electron`) was a placeholder — it loaded a **remote** `STOUT_SERVER_URL`
in a `BrowserWindow`, proving the same React shell can run inside Electron but not
yet being local-first.

This slice makes the desktop app actually **local-first**: it must own a real
local Git **working clone**, read and edit notes on disk, and run with **no
server dependency**. It optionally syncs to a **hub** (a remote Git repository it
clones from and pushes to) using an access **token** that must be stored encrypted
by the OS keychain and never logged or written in plaintext. Several forces shape
the design:

- **No UI fork (a hard criterion).** The desktop must present the *same* UI as the
  web app — the same built `@stout/ui` SPA and the same `/api/*` surface — so there
  is exactly one UI to maintain and it behaves identically in both runtimes.
- **No Postgres on the desktop.** The web stack's search runs on pgvector; a
  desktop app cannot assume a database. Search has to degrade to an in-process
  implementation, and "no database" must be the app's *healthy* state, not a
  degraded one.
- **The token is a secret.** It must be encrypted at rest by the OS keychain
  (Electron `safeStorage`), never persisted into `.git/config`, and never logged.
  The credential policy has to be unit-testable **without** a real keychain or
  network.
- **Tests are offline by design (repo-wide).** Like every prior slice, the new
  seams must be tested against in-memory fakes and local temp repositories — no
  live network, no real keychain, no packaged app required.
- **Packaging may not run in CI/here.** Producing a signed installer
  (electron-builder) needs platform toolchains we don't assume. The slice must
  still *build, typecheck, and unit-test* the adapters and policy; shipping an
  installer is a documented follow-up, not a prerequisite.

## Decision

### Reuse the exact server API + UI over a local clone (`@stout/server/desktop`)

Rather than fork anything, the desktop runs the **same** `createApp(...)` surface
and serves the **same** built `@stout/ui` SPA — only the backing differs. A new
`apps/server/src/desktop.ts` entry exposes `startLocalWorkspace({ cloneDir })`,
which wires the full note API (tree, read/save, autosave-squash sync,
create/rename/move, links, attachments, search) to a `NodeGitEngine` over a local
working clone and binds an Express host on **loopback** (`127.0.0.1`, ephemeral
port). The Electron window simply loads that URL. Because it is the same SPA and
the same API, the UI is byte-identical across runtimes — the no-fork criterion is
met structurally, not by discipline.

`@stout/server` now ships **two** entry points (`tsup src/index.ts
src/desktop.ts`, exposed via an `exports` map: `.` and `./desktop`). The desktop
entry's public surface is deliberately **Express-free** (`LocalWorkspace` is just
a `url` + `close()`), so the declarations the Electron app typechecks against do
not drag in `@types/express`.

### No Postgres: in-memory search, and "no database" is healthy

`startLocalWorkspace` builds its search service from the pure
`createHashingEmbedder()` + `InMemoryVectorStore` (ADR 0008's offline reference
impls) instead of the embedder/pgvector stack, and rebuilds the index from the
repo in the background on start. Health reports `status: "ok"` with `database:
false` — the desktop has no Postgres, and that is the expected local-first state,
so the UI's System section shows the DB as absent rather than the app reporting
degraded. Index updates on edits stay best-effort (logged, never failing an edit),
exactly as in the web server.

### Hub sync as pure policy over a narrow git seam (`core/hub-sync`)

The clone-then-sync **policy** lives in `@stout/core` (`hub-sync.ts`), pure and
runtime-agnostic. `syncWithHub(engine, tokenStore, config)` reads the token, bakes
it into the URL for a single git op, and either **clones** (first run) or
**pulls-then-pushes** (subsequent runs) over the narrow `HubRemoteEngine` seam
(`hasLocalClone` / `cloneFromHub` / `pullFromHub` / `pushToHub`). The credential
maths is pure and tested in isolation: `authenticateRemoteUrl` injects the token
as `x-access-token:<token>@host` userinfo, `stripRemoteCredentials` removes it, and
`redactRemoteUrl` masks it for logging. The `mechanism` — actually shelling `git
clone/pull/push` — is `NodeHubRemoteEngine` in `apps/server`, the hub-remote
counterpart to `NodeGitEngine`.

The token is materialised into a URL **only** at the moment a git op runs; after
cloning, `origin` is reset to the credential-free URL so the token is **never**
written to `.git/config`. The accepted tradeoff: the token is transiently visible
to a process listing for the duration of the op, which we prefer over persisting it
to disk in the remote config.

### Token at rest: the OS keychain behind injectable seams (`core/token-store`)

`core/token-store.ts` defines the secret-at-rest contract: a narrow `TokenStore`
(get/set/clear), a `SecureStorage` seam **shaped to match Electron's
`safeStorage`** (`isEncryptionAvailable` / `encryptString` / `decryptString`), and
a `SecureFilePorts` blob-IO seam. The pure `createSecureFileTokenStore` composition
encrypts **before** anything touches disk and **refuses to persist** when
encryption is unavailable — there is no plaintext fallback path. The Electron
adapter (`apps/electron/src/safe-storage.ts`) is a near-passthrough over
`safeStorage` plus a file under `app.getPath("userData")/hub-token.bin`; the only
adaptation is bridging the seam's `Uint8Array` to the `Buffer` Electron's decrypt
wants. Tests inject a reversible fake (`InMemoryTokenStore` or a fake
`SecureStorage`) — nothing in the policy imports `electron` or `node`.

### The Electron boot sequence

`apps/electron/src/main.ts` now: resolves the workspace under the user-data dir,
calls `bootstrapRepo` (if `STOUT_HUB_URL` is set, `syncWithHub` over
`NodeHubRemoteEngine`, reading the token from the OS keychain; otherwise — or on
any sync failure — falls back to `ensureWorkspaceRepo` for a purely-local
workspace), then `startLocalWorkspace` over the clone and opens the window on its
loopback URL. Only the hub-sync *action* and a redacted URL are ever logged. The
app depends on `@stout/server` (workspace) and externalises `electron` /
`@stout/server` / `@stout/core` in its build.

## Consequences

- **No UI fork (criterion met).** The desktop serves the same built `@stout/ui`
  and the same `/api/*` surface as the web server; the only difference is the
  backing (local clone + in-memory search vs. Postgres), so the UI is identical by
  construction, not by convention.
- **Truly local-first.** The window talks only to a loopback host over a local Git
  clone; with no hub configured the app needs no network at all, and "no database"
  is reported as healthy.
- **The token is never leaked.** It is encrypted by the OS keychain at rest, only
  ever lives in a git op's argv (never in `.git/config`), and only a redacted URL
  is logged. The transient process-listing exposure during a git op is the one
  accepted tradeoff, recorded here.
- **The hard parts are unit-tested offline.** The credential maths and
  clone-vs-sync decision are tested against an in-memory fake; the token store
  against a reversible fake `SecureStorage`; `NodeHubRemoteEngine` against a local
  bare repo acting as the "hub"; and `startLocalWorkspace` end-to-end via the API
  over a temp clone — all with no network and no real keychain.
- **Packaging is a documented follow-up.** This slice builds, typechecks, and
  unit-tests the desktop wiring, but does not produce a signed installer
  (electron-builder needs platform toolchains we don't assume here). Shipping an
  installer — and a small in-app UI to enter/clear the hub token (today it is read
  from the keychain, seeded out-of-band) — is additive and deferred.
- **First-run-offline-with-hub degrades, not crashes.** If a hub is configured but
  unreachable on first launch, the app falls back to a local workspace so it still
  opens; a later launch can sync. The edge where that local history later meets a
  populated hub (unrelated histories on pull) is a known limitation to address when
  hub provisioning lands.
