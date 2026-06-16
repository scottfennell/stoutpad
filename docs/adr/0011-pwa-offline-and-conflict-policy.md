# 11. PWA offline & multi-device conflict policy

- Status: Accepted
- Date: 2026-06-16
- Issue: #13 (PWA offline + multi-device sync & conflicts)

## Context

Through ADR 0010 the product runs as two backings of one UI: the web server
(Postgres + bare repo) and the local-first desktop (a local clone + in-memory
search). Both reach git through the same `core/git-engine` seam, and both have a
**single** writer per deployment, so there has never been a need to reconcile two
independent edits of the same note.

This slice opens the browser as a **third** runtime — an installable, **offline**
PWA that owns its **own** local clone in IndexedDB — and with it the first real
**multi-device** story: the same note can be edited on two devices while one (or
both) is offline, and those edits must later reconcile against a shared remote
with **zero data loss**. Several forces shape the design:

- **`@stout/core` stays pure (repo-wide invariant).** The conflict decision and
  the sync cadence are domain logic, not IO. They must be pure, runtime-agnostic,
  and unit-tested against fakes — no real timers, no real git, no DOM.
- **Same git engine, different filesystem.** The browser must run real git
  (`isomorphic-git`) against an IndexedDB-backed filesystem
  (`@isomorphic-git/lightning-fs`) while implementing the **same**
  `WritableGitEngine` seam the server's `NodeGitEngine` does — a backend swap
  behind one interface, not a parallel code path.
- **Zero data loss is non-negotiable.** A true conflict must never overwrite a
  user's words. Non-overlapping concurrent edits should merge silently; genuinely
  conflicting edits must keep **both** versions.
- **Conflicts must not interrupt.** The user learns a conflict copy was made
  through a **non-blocking** notification — never a modal, never a blocked editor.
- **Offline tests, again.** IndexedDB and service workers need a real browser, so
  the browser IO wiring is deliberately thin and the **logic** that carries the
  acceptance criteria (conflict policy, cadence, path maths) is pulled into pure
  modules tested in the offline suite.

## Decision

### The conflict policy is pure core (`core/conflict`)

`resolveNoteConflict(input)` is a pure three-way (base / local / incoming)
reconciliation over a note's **canonical Markdown**. It canonicalizes all three
versions first (so formatting-only differences never count as a conflict), then:

- if local and incoming are equal, or one side is unchanged from the base, it
  returns a **clean** result with the obvious winner (no conflict);
- otherwise it runs a line-level **diff3** (LCS sync-points chunk the two edits
  against the base). Non-overlapping changes **auto-merge** into one clean result;
  overlapping changes are a **true conflict**.

On a true conflict the policy **keeps the incoming `main` version on the note**
and preserves the **local** version as a sibling **conflict copy** — a new leaf
note named from the original plus a UTC marker (`YYYYMMDD-HHmmss`), its
frontmatter `title` set so it reads cleanly, its identity de-duplicated against
existing notes. It emits a `ConflictNotification` describing what happened. The
result is expressed as backing-file writes through the existing
`WritableGitEngine` seam (`applyConflictResolution`), so the same policy drives
the browser engine and could drive the server — keep-both, never overwrite.

### The sync cadence is pure core (`core/sync-cadence`)

`SyncScheduler` decides **when** to sync but owns no DOM and no real timer. It
runs a single injected `SyncRunner` on five triggers — **launch**, **reconnect**,
**focus**, **timer**, and **manual** — with three properties that make repeated,
overlapping triggers safe:

- **single-flight**: only one sync runs at a time;
- **coalescing**: triggers that arrive mid-flight collapse into one follow-up,
  keeping the *stronger* trigger (manual > reconnect > launch > timer > focus);
- **throttling**: only `focus` is rate-limited (`minIntervalMs`); the deliberate
  triggers (manual / reconnect / launch / timer) always run.

It records each run's outcome so the cadence is observable. The browser binding
(`packages/ui/sync-cadence-controller.ts`) is the thin adapter that maps
`online` → reconnect, window `focus` / `visibilitychange` → focus, a
`setInterval` → timer, construction → launch, and a "Sync now" call → manual, all
over injectable event targets/clock so it is unit-tested in jsdom.

### The browser git engine: same seam, IndexedDB filesystem (`packages/ui`)

`BrowserGitEngine` implements `WritableGitEngine` by driving `isomorphic-git`
against a `lightning-fs` filesystem persisted in IndexedDB — the browser
counterpart to `NodeGitEngine`. Commit-on-save semantics match: list the `.md`
files at `HEAD`, read one note (path-escape-guarded), and write + commit an edited
note, skipping no-op writes so there are no empty commits. `ensureBrowserRepo`
idempotently inits and seeds the repo on first run, mirroring the server's
`ensureWorkspaceRepo`. The pure path maths (safety guard, joins, ancestor dirs,
tracked-file → `NoteFile` mapping) is split into `browser-fs.ts` and unit-tested;
the engine itself is the thin IO over the two libraries, exercised in a real
browser (it needs IndexedDB), not the offline suite.

### The PWA shell: Workbox `generateSW` via `vite-plugin-pwa`

`@stout/ui`'s Vite build gains `vite-plugin-pwa` (Workbox `generateSW`,
`registerType: "autoUpdate"`): a web app **manifest** (name, theme, the brand
`icon.svg`) and a **service worker** that precaches the SPA shell + assets so the
app installs and boots offline. The navigation fallback serves `index.html` for
app routes but **denylists** `/api` and `/assets`, so live server routes are never
shadowed by the cached shell. The SW is registered once from `main.tsx`
(`virtual:pwa-register`), never from `App.tsx`, mirroring how the theme stylesheet
is entry-only so unit tests are unaffected.

### The conflict notification: a non-blocking toast wired into the shell

`ConflictToasts` renders the conflict notifications as a small, dismissible stack
in a **polite live region** (`role="status"`, `aria-live="polite"`) anchored to a
corner — never a modal. Each toast states what happened and offers **"Open copy"**
(navigates to the saved sibling via the same `selectNote` the tree and wikilinks
use) and **"Dismiss"**. `App` owns the toast list (`useConflictNotifications`) and
exposes a `notify` handle through an optional `onConflicts` prop: the
server-backed web app leaves it unset (the server reconciles before the client
sees a conflict), and the PWA offline runtime wires it to its sync controller's
conflict notifications (see the offline-runtime assembly below). The editor stays
fully interactive behind the toast.

### The offline runtime: one App, a swappable data source (`packages/ui`)

The browser pieces above are **assembled** into a running, server-free app
without forking the UI. The whole `App` reads and writes through a single
`fetch`-shaped **data-source seam** (`AppProps.fetchImpl`, default the global
`fetch`): every hook (`useHealth`/`useTree`/`useNote`/`useLinks`/`useSearch`/
`useNoteSync`) and every `*-client.ts` already accepts an injected `fetch`, so
threading one prop from `App` is the entire change. The server-backed web app and
Electron leave it unset and talk to the live `/api/*` HTTP surface, unchanged.

The offline runtime instead injects `createBrowserApiFetch(engine)` (`browser-api.ts`):
a `typeof fetch` that answers the **same** `/api/*` contracts **locally** by
running the same `@stout/core` compositions against the IndexedDB
`BrowserGitEngine` — `readNoteTree`/`readNote`/`writeNote`/`readLinkGraph`,
`keywordSearch` over `readSearchableNotes`, and `applyNoteSync` over a
`createCommitOnSaveWipEngine` (offline is a single writer, so an autosave commits
straight to `main` and squash/delete-wip are no-ops). Reads, edits, links,
search, and the autosave loop are fully offline; note mutations and attachments
return a graceful `501` until the browser engine grows those seams.

`startOfflineApp(container)` (`offline-runtime.tsx`) is the composition root:
`ensureBrowserRepo()` → `new BrowserGitEngine()` → `createBrowserApiFetch` →
`createSyncController(createOfflineSyncRunner({ notify }))` → render
`<App fetchImpl onConflicts/>`. The offline `SyncRunner` (`offline-sync.ts`)
reconciles with a remote and forwards conflict notifications to the toast sink;
a purely local PWA has no remote, so its reconcile is omitted and the runner is a
well-behaved no-op that still records cadence runs. One built SPA serves both
runtimes: `main.tsx` picks at load time via `resolveRuntimeMode(location.search)`
(`runtime.ts`), and the manifest's `start_url` is `/?runtime=offline` so the
installed PWA boots offline while the web app at `/` stays on the server.

## Consequences

- **The acceptance-critical logic is pure and offline-tested.** The conflict
  policy (auto-merge + keep-both-as-copy) and the five-trigger cadence are pure
  `@stout/core` modules with unit tests; the browser path maths and the toast UI
  are tested in jsdom. Zero data loss is a property of the pure policy, proven by
  test, not by a live browser run.
- **One git seam, three runtimes.** `BrowserGitEngine` implements the very same
  `WritableGitEngine` as `NodeGitEngine`, so the offline browser backend is a
  filesystem swap (IndexedDB vs. disk) behind one interface — the same no-fork
  discipline ADR 0010 established for the desktop.
- **The app is installable and boots offline.** The generated service worker
  precaches the shell; the manifest makes it installable and its `start_url`
  (`/?runtime=offline`) boots the installed app straight into the offline runtime,
  which reads and edits the IndexedDB clone through `BrowserGitEngine` with **no
  server**.
- **Conflicts never interrupt or destroy.** A true conflict keeps the incoming
  version on the note and the local version as a sibling copy, surfaced by a
  non-blocking toast that jumps to the saved work.
- **The offline data-path swap is wired, not deferred.** The running `App` no
  longer hard-codes `/api/*`: it reads/writes through an injected `fetch` seam, and
  the offline runtime supplies `createBrowserApiFetch(BrowserGitEngine)` so the
  editor, tree, links, search, and autosave loop run entirely against the IndexedDB
  clone — same App, same contracts, no fork. `resolveRuntimeMode` + the manifest
  `start_url` select the runtime at load. This swap is **unit-tested offline** (the
  adapter and the sync runner against in-memory fakes); end-to-end exercise on a
  real IndexedDB-backed browser is the documented follow-up, since the engine needs
  a real browser.
- **A few seams remain server-only offline.** Note **mutations** (create / rename /
  move) and **attachments** return a graceful `501` in the offline adapter until
  `BrowserGitEngine` grows those write seams, and a purely local PWA has **no
  remote**, so the offline `SyncRunner`'s reconcile (the actual pull/push +
  `resolveNoteConflict` against a shared hub) is a no-op placeholder. Both are
  additive: the contracts and the conflict policy already exist, so each is a wiring
  change behind the seam, not a redesign.
- **Icons are SVG for now.** The manifest references a single scalable
  `icon.svg`; rasterized 192/512 PNG icons (and richer maskable art) are a small
  follow-up that does not change the architecture.
