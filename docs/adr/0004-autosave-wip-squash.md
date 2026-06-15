# 4. Autosave onto a wip branch, squash-merged into main per session

- Status: Accepted
- Date: 2026-06-15
- Issue: #6 (Autosave + wip-branch squash for meaningful history)

## Context

Commit-on-save (ADR 0003) persists each debounced edit as its own commit on
`main`. That is durable, but it conflates two things users want kept apart:
**autosave** (never lose a keystroke, survive a reload/crash) and **clean
history** (one meaningful commit per editing session, not one per pause in
typing). Left as-is, `main` accrues a commit every few seconds of typing, and
the history that is supposed to be a feature — git as the single source of truth
— becomes noise.

The PRD names `core/sync` as the seam that reconciles the two: debounce edits,
commit them somewhere ephemeral so nothing is lost, then collapse the session
into a single commit on `main`. Several things need deciding:

1. **Where in-progress edits live.** They must be real commits (so a reload or
   crash recovers them), but not on `main` (so they don't pollute history).
2. **When the collapse happens, and to what.** A session must end on the natural
   "I'm done here" signals — focus leaving the note, the tab hiding, the app
   quitting, an idle timeout — and produce exactly one `main` commit.
3. **Where the logic runs.** `@stout/core` must stay pure (no Node, no Git, no
   real timers), yet the same orchestration has to run in the browser (over
   `fetch`) and on the server (over real Git), and be unit-testable offline.
4. **What is never allowed.** WIP branches are local scratch space; they must
   never be pushed to the bare repo.

## Decision

### Editing session model (`core/sync`, pure)

- An **editing session** is one note's edit lifecycle: it begins when a note is
  loaded for editing and ends on a focus-leave / idle / quit signal. Within a
  session, edits are buffered, debounced (~3s idle, `DEFAULT_DEBOUNCE_MS`), and
  committed onto an ephemeral **wip branch** named `wip/<note>`
  (`wipBranchName`, a pure, Git-ref-safe slug of the note's `path`; the root note
  is `wip/root`). Ending the session **squash-merges** the wip branch into
  `main` as one commit and deletes the branch.
- The orchestrator is `NoteSync`, a **pure state machine**: it owns no real
  timer and no Git. It depends on an injected `WipSyncEngine` and an injected
  `SyncClock`, and is driven entirely through explicit methods — `onEdit(markdown)`
  to buffer a change, `tick(nowMs)` / `flush()` to advance or force the debounce,
  and `onFocusLeave()` / `onIdle()` / `onQuit()` to end the session. This makes
  debounce and squash triggers exercisable with a virtual clock, deterministically
  and offline.
- The machine **canonicalizes** every edit (`canonicalizeMarkdown =
  serializeMarkdown ∘ parseMarkdown`, ADR 0003) before committing and **dedupes**
  against the last persisted content (seeded from the note's `initialMarkdown`),
  so typing then reverting commits nothing and no empty wip commit is created.
- Session-end is **idempotent**: overlapping triggers (a blur followed by a quit)
  collapse to one squash. Crucially, ending a session with **zero** wip commits
  does *not* delete any branch — an orphan `wip/<note>` left by a prior crash must
  survive to be squashed by a later session, never silently dropped.

### The wip-branch seam (`WipSyncEngine` / `WipGitEngine`)

- `NoteSync` drives a deliberately **narrow** `WipSyncEngine`: `wipBranchName`,
  `commitToWip(note, markdown)`, `squashMergeWipToMain(note, message)`,
  `deleteWip(note)`. There is **no push operation** in the seam — "WIP branches
  are never pushed" is true *by construction*, not by convention.
- The server's `WipGitEngine extends WritableGitEngine, WipSyncEngine`: the wip
  lifecycle layers on top of commit-on-save behind one interface, mirroring the
  `MigrationStore` / `GitEngine` pattern — pure composition tested against an
  in-memory double, production shelling out to real git.

### Server endpoint and dispatcher (`POST /api/note/sync`)

- The browser can't run Git, so each wip operation is one thin HTTP action.
  `SYNC_PATH = /api/note/sync` (POST) takes a `NoteSyncRequest`
  (`{ path, action, markdown?, message? }`) where `action` is `autosave` |
  `squash` | `delete-wip`, and returns a `NoteSyncResponse`.
- `applyNoteSync(engine, request)` is the pure-but-for-the-engine dispatcher
  (the counterpart to `readNote`/`writeNote`): `autosave` → `commitToWip`
  (Markdown required, canonicalized; absent ⇒ a 400 at the route), `squash` →
  `squashMergeWipToMain` (message defaulted via `defaultSessionMessage`),
  `delete-wip` → `deleteWip`. The HTTP layer only validates and delegates.

### Node engine (`apps/server`)

- `NodeGitEngine implements WipGitEngine`. `commitToWip` checks out `wip/<note>`
  (creating it from `main` on the first commit of a session, appending after),
  writes the note's stable backing file, and commits — skipping a no-op so there
  are no empty wip commits. `squashMergeWipToMain` does `git merge --squash` +
  `commit`, producing a **plain, linear** commit on `main` (not a merge commit) —
  one commit per session. `deleteWip` removes the branch.
- Every wip operation restores the clone to a clean `main` checkout
  (`git checkout -f main`) in a `finally`, so the working tree that the read and
  commit-on-save paths share is always a stable `main` baseline, and a
  half-applied squash on an error path is discarded (it only ever drops
  uncommitted working-tree state, never a commit). Nothing in the engine pushes.

### UI wiring (`packages/ui`)

- `createHttpWipEngine(fetch)` is the browser's `WipSyncEngine` — a thin adapter
  mapping `commitToWip`/`squashMergeWipToMain`/`deleteWip` onto `postNoteSync`
  (`POST /api/note/sync`, sent with `keepalive: true` so a squash fired during
  tab-hide/unload still reaches the server). So the **same** `core/sync` state
  machine that the server could drive over real Git runs in the client over
  `fetch`.
- The `useNoteSync` hook owns one `NoteSync` per loaded note. The editor's
  `onChange` buffers each edit and (re)starts a real `setTimeout` debounce that
  calls `flush()`; the session is ended (flush + squash + delete) on `blur`,
  `visibilitychange`→hidden, `pagehide`, and on switching notes or unmounting.
  This replaces ADR 0003's `useDebouncedSave` → `postNote` autosave path
  (commit-on-save's `POST /api/note` endpoint remains for non-autosave saves).

## Consequences

- **Autosave and clean history are decoupled and both satisfied.** In-progress
  edits are real commits on `wip/<note>` (crash-recoverable), while `main` gets
  exactly one commit per editing session. The acceptance criteria — debounced
  autosave to a wip branch, crash survival, squash on focus-leave/idle/quit with
  a sensible message, one commit per session, never pushed — are met.
- **The orchestration is pure and tested once, reused twice.** Debounce timing,
  the dedupe, the squash triggers, and the idempotent/orphan-preserving
  session-end all live in `core/sync` and are unit-tested against an in-memory
  `WipSyncEngine` with a virtual clock (no Git, no real timers). "Never pushed"
  is asserted at two levels: the core seam exposes no push (and the op log shows
  none), and the Node tests assert the bare repo grows no `wip/*` ref. The Node
  wip lifecycle is tested against real git in a temp clone.
- **One squash endpoint, three small actions.** The browser stays Git-free; all
  Git lives server-side behind `applyNoteSync`. Adding richer session policy
  later (e.g. server-driven idle timeout) is a new caller of the same engine.
- **Shared `main` working tree is a known constraint.** Because wip operations
  reuse the single clone and snap it back to `main`, concurrent editing sessions
  for different notes serialize through one working tree. Acceptable for the
  single-user desktop target now; a worktree-per-session (or in-memory Git) is
  the escape hatch if multi-note concurrency ever needs true isolation.
- **WIP branches are ephemeral and local only.** Until the sync slice pushes
  `main` to the bare repo, a session's squashed commit lives on the clone's
  `main` (consistent with ADR 0003's deferred push). Orphan wip branches from a
  crash are preserved, not garbage-collected, and fold into the next session's
  squash — at the cost that a never-reopened note could leave a dangling local
  `wip/<note>` until it is edited again.
