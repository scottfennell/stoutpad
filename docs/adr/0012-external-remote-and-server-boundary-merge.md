# 12. External remote (GitHub) & server-side boundary merge

- Status: Accepted
- Date: 2026-06-16
- Issue: #14 (External remote (GitHub) config + server-side merge)
- Blocked by: #6 (autosave & squash — supplied the `core/sync` seam reused here)

## Context

Through ADR 0011 the product runs as three backings of one UI, and the
multi-device story gained a pure, zero-data-loss **conflict** policy
(`core/conflict`) and a pure sync **cadence** (`core/sync-cadence`). But the web
server is still an island: its **bare repo** is the only source of truth, written
by exactly one actor (the server itself), so it has never had to integrate work
that arrived from *outside*.

This slice makes the source-of-truth repo **configurable**. By default the server
keeps using its internal **bare repo** exactly as before. Optionally it can be
pointed at an **external remote** — e.g. a GitHub repository — that *other actors
can also write to* (a teammate, a `git push` from a laptop, a CI job). The server
**stays the sync hub** the clients see; it just additionally pulls-from and
pushes-to that external remote on its sync loop. Several forces shape the design:

- **Clients must stay unaware.** No client-facing contract changes. The browser,
  the desktop, and the web SPA keep talking to the same `/api/*` surface; whether
  the server's `main` is also mirrored to GitHub is invisible to them.
- **The external history can diverge.** Because another actor can push to the
  external remote, a fetch can bring history that is *not* a fast-forward of the
  server's `main`. The server cannot blindly `git merge` (that would either fail
  on conflicts or silently resolve them with git's line union) — it must merge
  with the **same** keep-both policy the multi-device story uses, so a real
  conflict never destroys a user's words.
- **`@stout/core` stays pure (repo-wide invariant).** The boundary-merge *policy*
  is domain logic, not IO. It must be pure, runtime-agnostic, and unit-tested
  against a fake — no real git, no network — exactly like every other core module.
- **Credentials are a server-side secret.** The external remote's access token is
  configured on the server only, never sent to a client, never written to
  `.git/config`, never logged in plaintext.
- **Offline tests, again.** A live GitHub remote needs the network, so the
  acceptance-critical logic is pulled into a pure core module tested against an
  in-memory fake, and the Node `git`-shelling is tested against a **local** bare
  repo standing in for "the external remote" — the whole suite stays offline.

## Decision

### The boundary-merge policy is pure core (`core/remote-sync`)

A new `core/remote-sync` module owns the policy, split the same way the rest of
core is:

- **`reconcileNotesWithIncoming(notes, options)`** is the pure heart. Given each
  changed note's three versions — **base** (the merge base), **local** (the
  server's `main`), and **incoming** (the fetched external tip) — it decides, per
  note keyed by **identity**, what to do, by deferring to the existing
  `resolveNoteConflict` from `core/conflict`:
  - **incoming absent** → the external side does not have the note; keep local,
    emit nothing. External *deletions are not propagated* — a deliberate
    no-data-loss choice (a delete that races an edit would otherwise lose the
    edit; re-creating a note locally is cheap, un-deleting words is not).
  - **local absent** → the external side added it; **adopt** it (clean).
  - **already equal** (canonically) → nothing to do.
  - **both present and differing** → `resolveNoteConflict`: a non-overlapping
    three-way **auto-merges** (clean); a true overlap keeps the **incoming**
    version on the note and the **local** version as a sibling **conflict copy**,
    with a `ConflictNotification`. A missing base is treated as the empty ancestor
    so two independent *creations* of one identity conflict (keep both) rather
    than clobber. Conflict copies are de-duplicated against every existing
    identity and every copy planned this round.

- **`syncRemoteBoundary(engine, tokenStore, config, options)`** is the
  orchestrator: read the token and authenticate the URL (reusing the
  `core/hub-sync` credential maths), `fetchBoundary` the branch, gather each
  changed note's base/local/incoming over the seam, `reconcileNotesWithIncoming`,
  `applyConflictResolution` each result to `main`, `recordBoundaryMerge` so `main`
  descends from the external tip, then `pushBoundary`. An **empty remote** (no such
  branch yet) is just *published* to (seed the branch). It is pure but for the
  injected store and engine; the token is materialised into a URL only for the
  fetch/push and never returned, logged, or persisted.

The IO lives behind a narrow seam, `RemoteBoundaryEngine extends WritableGitEngine`
— `fetchBoundary` / `changedNoteFiles` / `readFileAt` / `recordBoundaryMerge` /
`pushBoundary`, on top of the `main` reads/writes core already defines. The pure
module is unit-tested end-to-end against an in-memory `FakeBoundaryEngine`.

### We never let git merge content; the merge commit is bookkeeping

The crucial discipline: **divergent history is merged by the conflict policy, not
by git.** By the time we record a merge, `reconcileNotesWithIncoming` +
`applyConflictResolution` have *already* written the correct, reconciled tree onto
`main` (clean auto-merges, adopted notes, and conflict copies all committed). So
`recordBoundaryMerge` only needs to make the external tip an **ancestor** of
`main` — making the subsequent push a fast-forward — *without* touching content.
The Node engine does this with `git merge -s ours --no-edit
--allow-unrelated-histories <ref>`: keep our (reconciled) tree, add the external
tip as a second parent. It is a no-op when the tip is already an ancestor. This is
why the policy is the merge and git is just plumbing.

### The Node side: `NodeRemoteBoundaryEngine` (`apps/server`)

`NodeRemoteBoundaryEngine extends NodeGitEngine implements RemoteBoundaryEngine`
adds the handful of remote-boundary `git` ops by shelling out — `fetch` the
external branch, `diff --name-only` it against `main`, `show <ref>:<file>` to read
a file at any ref, the `-s ours` merge commit, and `push HEAD:<branch>`. It is the
**only** new place that touches `git`, the external-remote counterpart to
`NodeGitEngine` (mirroring how `NodeHubRemoteEngine` is the hub counterpart). It
extends `NodeGitEngine` so a **single** engine instance serves both the HTTP layer
(reads/writes/commits `main`) and the sync loop. Like the hub engine, the token
only ever appears in the argv of a single `git` fetch/push (the
already-authenticated URL); it is never written to `.git/config`.

### Config selects internal-only (default) or an external remote

`loadRemoteConfig(env)` resolves `STOUT_REMOTE_URL` (alias `REMOTE_URL`),
`STOUT_REMOTE_BRANCH` (alias `REMOTE_BRANCH`, default `main`), and the credential
`STOUT_REMOTE_TOKEN` (alias `REMOTE_TOKEN`). Unset ⇒ `null` ⇒ the server uses only
its internal **bare repo**, exactly as before — the feature is strictly additive
and off by default. The token is read **server-side** only and handed to an
`InMemoryTokenStore`, reusing the `core/token-store` `TokenStore` seam.

### The sync loop reuses the pure cadence (`apps/server/index.ts`)

`startRemoteSyncLoop` drives `syncRemoteBoundary` through the pure
`core/sync-cadence` `SyncScheduler` (single-flight + coalescing), requesting a sync
on **launch** and on a periodic **timer** (`DEFAULT_SYNC_PERIOD_MS`, an `.unref()`'d
interval). Conflict copies are **logged** (the server has no UI to toast them), the
search index is rebuilt after a sync that may have changed `main`, and any failure
(e.g. a push rejected because the remote moved again) only logs and is retried on
the next tick — it never crashes the server.

## Consequences

- **The source-of-truth repo is configurable, off by default.** With no
  `STOUT_REMOTE_URL` the server is byte-for-byte the same island it was. With one
  set, its `main` is continuously reconciled with an external GitHub repo while the
  server stays the hub the clients see.
- **Divergent external history is merged with the existing conflict policy, not
  git.** Non-overlapping external edits auto-merge; a genuine conflict keeps **both**
  versions (incoming on the note, local as a **conflict copy**) — the very same
  `core/conflict` reconciliation the multi-device story uses, so zero data loss is a
  property already proven by the conflict tests and reused here.
- **Clients are unchanged and unaware.** No client-facing contract moved; the entire
  feature lives in a new core module, a new server engine, and the server's own boot
  wiring. The browser/desktop/web SPA neither know nor care that `main` is mirrored.
- **Credentials stay a server-side secret.** The token is env-configured on the
  server, kept in a `TokenStore`, injected into a URL for a single `git` op, and
  never persisted to `.git/config`, returned, or logged in plaintext (the URL is
  redacted for the one startup log line).
- **The boundary merge is offline-tested.** The pure policy is unit-tested against an
  in-memory `FakeBoundaryEngine`, and the Node `git`-shelling against a **local bare
  repo** standing in for the external remote (a second actor pushes to it; the suite
  asserts auto-merge + push-back, keep-both-on-conflict + notify, and empty-remote
  publish) — all with no network.
- **Known limitations (documented follow-ups).** (1) The server runs one engine
  instance for both the HTTP layer and the loop with no internal git lock, so a save
  landing on `main` exactly while a boundary merge runs is an unguarded race — the
  next tick reconciles it, but a mutex around the working clone is the proper fix.
  (2) External **deletions** and external **note mutations** (rename/move that re-keys
  identities) are not propagated into the local tree — the merge is per-note content
  only. (3) `changedNoteFiles` dedupes by identity, so the rare leaf↔parent rename on
  the external side that maps two files to one identity takes the first. None of
  these lose data; each is an additive refinement behind the same seam.
