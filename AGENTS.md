# AGENTS.md

## Project layout

pnpm + Turborepo monorepo (the "walking skeleton", issue #1):

- `packages/core` — runtime-agnostic domain contracts (`@stout/core`). Pure, no Node/DOM deps. Holds shared types like `HealthStatus`, the **note-tree** mapper (`note-tree.ts`: file set → unified tree, pure), and the **git-engine** read seam (`git-engine.ts`: `GitEngine` interface + `readNoteTree`).
- `packages/ui` — Vite React SPA (`@stout/ui`). Builds to `dist/`, which the server serves statically. Talks to the server only via `/api/*`.
- `apps/server` — Express host (`@stout/server`). Bootstraps Postgres, runs migrations, exposes `/api/health`, and serves the UI build. Entry: `src/index.ts`.
- `apps/electron` — minimal Electron shell (`@stout/electron`) loading the server-hosted UI.

### Server seams (keep these testable)

- `apps/server/src/migrate.ts` — migration runner decoupled via the `MigrationStore` interface (in-memory store in tests, pg-backed in prod). Add migrations to `src/migrations.ts`.
- `apps/server/src/db.ts` — `bootstrapDatabase` creates/uses the dedicated `stout` database and enables the `vector` extension; `PgMigrationStore` is the pg-backed ledger.
- `apps/server/src/git-engine.ts` — Node side of `core/git-engine`. `ensureWorkspaceRepo` initializes the bare repo + working clone (seeded with a starter `_index.md`) on first boot; `NodeGitEngine` implements the `@stout/core` `GitEngine` read seam by shelling out to `git ls-files`. The pure file→tree mapping stays in `core/note-tree`. Requires the `git` binary at runtime (added to the Docker runner image).
- `apps/server/src/app.ts` — `createApp({ getHealth, getTree?, uiDir? })` takes injectable deps so HTTP behavior is tested without a live DB or repo. `getTree` is wired in prod to `readNoteTree(NodeGitEngine)` and exposed at `GET /api/tree` (contract `TREE_PATH`/`NoteTreeResponse` in `@stout/core`).

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
