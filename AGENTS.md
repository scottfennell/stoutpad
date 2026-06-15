# AGENTS.md

## Project layout

pnpm + Turborepo monorepo (the "walking skeleton", issue #1):

- `packages/core` — runtime-agnostic domain contracts (`@stout/core`). Pure, no Node/DOM deps. Holds shared types like `HealthStatus`, the **note-tree** mapper (`note-tree.ts`: file set → unified tree, pure), the **note-content** read/write contract (`note-content.ts`: `NOTE_PATH` + `NoteContentResponse`/`NoteSaveRequest` + the pure identity→backing-file resolver `noteFileCandidates`), the **git-engine** read/write seam (`git-engine.ts`: `GitEngine`/`WritableGitEngine` interfaces + `readNoteTree`/`readNote`/`writeNote` + the identity→backing-file write resolver `resolveWriteTarget`), the pure **markdown** module (`markdown.ts`: `parseMarkdown`/`parseInline` → block model incl. headings, lists, and checkbox task lists, plus the deterministic+idempotent canonical serializer `serializeMarkdown` and the `canonicalizeMarkdown` = `serialize∘parse` shorthand; no DOM), and the **sync** module (`sync.ts`: the pure autosave+squash state machine `NoteSync` driven through `onEdit`/`tick`/`flush`/`onFocusLeave`/`onIdle`/`onQuit` against an injected `SyncClock` + the narrow `WipSyncEngine`/`WipGitEngine` seam, `wipBranchName`, the `SYNC_PATH`/`NoteSyncRequest`/`NoteSyncResponse`/`SyncAction` HTTP contract, and the server-side dispatcher `applyNoteSync`; no push, by construction).
- `packages/ui` — Vite React SPA (`@stout/ui`). Builds to `dist/`, which the server serves statically. Talks to the server only via `/api/*`. The center panel renders a note through the swappable **Editor seam** (`editor.ts`: the `EditorComponent` "Markdown in, change events out" contract + pure Markdown↔ProseMirror-JSON bridge), with `TipTapEditor.tsx` as the default TipTap implementation (live formatting + checkboxes). Editor `onChange` drives the autosave+squash session via the `useNoteSync` hook (`App.tsx`), which runs the `@stout/core` `NoteSync` machine over the HTTP `WipSyncEngine` adapter in `sync-client.ts` (`createHttpWipEngine`/`postNoteSync` → `POST /api/note/sync`): debounced edits autosave to the note's `wip/<note>` branch and the session squash-merges into `main` on focus-leave/hide/unload/note-switch. (The commit-on-save `postNote` → `POST /api/note` path still exists for explicit saves.)
- `apps/server` — Express host (`@stout/server`). Bootstraps Postgres, runs migrations, exposes `/api/health`, and serves the UI build. Entry: `src/index.ts`.
- `apps/electron` — minimal Electron shell (`@stout/electron`) loading the server-hosted UI.

### Server seams (keep these testable)

- `apps/server/src/migrate.ts` — migration runner decoupled via the `MigrationStore` interface (in-memory store in tests, pg-backed in prod). Add migrations to `src/migrations.ts`.
- `apps/server/src/db.ts` — `bootstrapDatabase` creates/uses the dedicated `stout` database and enables the `vector` extension; `PgMigrationStore` is the pg-backed ledger.
- `apps/server/src/git-engine.ts` — Node side of `core/git-engine`. `ensureWorkspaceRepo` initializes the bare repo + working clone (seeded with a starter `_index.md`) on first boot; `NodeGitEngine` implements the `@stout/core` `WipGitEngine` seam by shelling out to git. Commit-on-save / reads: `git ls-files` (`listNoteFiles`), reading a single note file off the working clone path-escape-guarded (`readNoteFile`), and writing + committing an edited note to `main` (`writeNoteFile`: `git add` + `git commit`, path-escape-guarded, skips no-op saves so there are no empty commits). Wip lifecycle (autosave+squash): `commitToWip` (checkout/create `wip/<note>` from `main`, write the backing file, commit — skipping no-ops), `squashMergeWipToMain` (`git merge --squash` + commit → one plain, linear `main` commit per session), and `deleteWip`; every wip op snaps the clone back to a clean `main` (`checkout -f main`) and nothing pushes, so wip branches stay local. The pure file→tree / identity→file mapping, the canonicalize-then-persist composition (`writeNote`), and the wip-branch slug (`wipBranchName`) stay in `core`. Requires the `git` binary at runtime (added to the Docker runner image).
- `apps/server/src/app.ts` — `createApp({ getHealth, getTree?, getNote?, saveNote?, syncNote?, uiDir? })` takes injectable deps so HTTP behavior is tested without a live DB or repo. `getTree` is wired in prod to `readNoteTree(NodeGitEngine)` and exposed at `GET /api/tree` (contract `TREE_PATH`/`NoteTreeResponse`); `getNote` is wired to `readNote(NodeGitEngine, path)` and exposed at `GET /api/note?path=<identity>` (contract `NOTE_PATH`/`NoteContentResponse`, 404 when the note is missing); `saveNote` is wired to `writeNote(NodeGitEngine, path, markdown)` and exposed at `POST /api/note` (contract `NOTE_PATH`/`NoteSaveRequest` body → canonical `NoteContentResponse`, 400 when `markdown` is absent); `syncNote` is wired to `applyNoteSync(NodeGitEngine, request)` and exposed at `POST /api/note/sync` (contract `SYNC_PATH`/`NoteSyncRequest` → `NoteSyncResponse`, 400 on an unknown action or an `autosave` missing `markdown`). All contracts live in `@stout/core`.

## Dev workflow

- Install: `pnpm install`
- Build / test / typecheck all packages: `pnpm build`, `pnpm test`, `pnpm typecheck` (Turborepo, respects the `core → ui → server` build order).
- Run the server (needs built packages + a reachable Postgres): `pnpm start`.
- Full local stack: `docker compose up` (brings up a `pgvector` Postgres + the app container).

### Configuration

- `DATABASE_URL` points at the Postgres **maintenance** database (e.g. `.../postgres`); the server creates/switches to the dedicated `STOUT_DB_NAME` (default `stout`) itself. `STOUT_DATA_DIR` (default `data`, `/data` in the container) holds the note repo: a bare repo (`repo.git`) + working clone (`clone`). `PORT` defaults to `3000`. See `.env.example`.

### Environment notes

- pnpm 11 reads build-script allowlists and run settings from `pnpm-workspace.yaml` (`onlyBuiltDependencies`, `verifyDepsBeforeRun`, `strictDepBuilds`), not `.npmrc`.
- Tests are offline by design: the deep/seam logic (migration runner, health round-trip) is tested against in-memory/injected fakes, not a live Postgres.

## Agent skills

### Issue tracker

Issues are tracked as GitHub issues in `scottfennell/stoutpad` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), used as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
