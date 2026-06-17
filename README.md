# Stout

A high-fidelity, interlinked note-taking application built on open standards — **Markdown**, **Git**, and a **vector database**. Notes are plain Markdown files in a Git repository (the source of truth), edited through a live editor, linked with `[[wikilinks]]`, and searched semantically. Stout runs three ways from one codebase: a **server-hosted web app**, an **offline-capable PWA**, and a **local-first Electron desktop** app.

> For architecture, domain language, and design decisions see [`AGENTS.md`](AGENTS.md), [`CONTEXT.md`](CONTEXT.md), the ADRs in [`docs/adr/`](docs/adr/), the design system in [`DESIGN.md`](DESIGN.md), and the product brief in [`stout_project_brief_prd.md`](stout_project_brief_prd.md).

## Repository layout

A pnpm + Turborepo monorepo:

| Package | Description |
|---|---|
| `packages/core` (`@stout/core`) | Pure, runtime-agnostic domain logic + HTTP contracts (note tree, markdown, sync, search, conflict, wikilinks, …). No Node/DOM deps. |
| `packages/ui` (`@stout/ui`) | Vite + React SPA. Builds to `dist/`, served statically by the server. Also the offline PWA runtime. |
| `apps/server` (`@stout/server`) | Express host. Bootstraps Postgres, runs migrations, serves the UI + `/api/*`. Also ships an Express-free `@stout/server/desktop` entry. |
| `apps/electron` (`@stout/electron`) | Local-first desktop shell hosting the same UI + API over a local Git clone. |

## Prerequisites

- **Node.js** >= 20 (the container uses Node 22)
- **pnpm** 11 (`corepack enable` then `corepack prepare pnpm@11.0.8 --activate`)
- **git** — required at runtime (the server initializes a bare repo + working clone and shells out to `git`)
- **Postgres** with the `pgvector` extension available (only for the web server; the `pgvector/pgvector` image provides it). Not needed for the Electron desktop app.
- **Docker** + Docker Compose (optional, for the full local stack)

## Build & verify

From the repo root:

```bash
pnpm install          # install all workspace deps
pnpm build            # build core -> ui -> server -> electron (respects the dependency graph)
pnpm test             # run all unit tests (offline by design — no DB/network needed)
pnpm typecheck        # type-check every package
```

Turborepo runs tasks in dependency order and caches results. To build a single package: `pnpm --filter @stout/ui build`.

## Run locally

### Option A — full stack with Docker Compose (recommended)

Brings up a `pgvector` Postgres plus the app container (which builds the whole monorepo):

```bash
docker compose up --build
```

Then open <http://localhost:3000>. Notes persist in the `stout-data` volume; Postgres in `postgres-data`.

### Option B — run the server against your own Postgres

1. Copy the env template and adjust as needed:
   ```bash
   cp .env.example .env
   ```
   `DATABASE_URL` should point at the Postgres **maintenance** database (commonly `postgres`); the server creates/switches to the dedicated `STOUT_DB_NAME` (default `stout`) itself and enables the `vector` extension on boot.
2. Build, then start:
   ```bash
   pnpm build
   pnpm start          # runs @stout/server (serves the built UI + /api/*)
   ```
   The server listens on `PORT` (default `3000`). On first boot it initializes the note repo (a bare repo + working clone seeded with a starter note) under `STOUT_DATA_DIR` (default `./data`).

Health check: `GET /api/health` returns the service/database/migration status the UI renders.

### Option C — Electron desktop (local-first)

Runs the same UI + API over a **local** Git clone (under the app's user-data dir) with an in-memory search index — no Postgres, and by default no network.

```bash
pnpm build
pnpm --filter @stout/electron start
```

Optionally set `STOUT_HUB_URL` to sync the local clone with a Git "hub" (the hub token is stored encrypted in the OS keychain, never in an env var). See `.env.example`.

> Packaging a distributable binary (electron-builder) is a documented follow-up — see [`docs/adr/0010-electron-local-first.md`](docs/adr/0010-electron-local-first.md).

## Configuration

All configuration is via environment variables (see [`.env.example`](.env.example) for the full, annotated list):

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Postgres maintenance DB URL (web server only). |
| `STOUT_DB_NAME` | `stout` | Dedicated application database the server creates/uses. |
| `STOUT_DATA_DIR` | `data` (`/data` in the container) | Holds the note repo (bare repo + working clone). |
| `PORT` | `3000` | Port the server listens on. |
| `STOUT_REMOTE_URL` / `STOUT_REMOTE_BRANCH` / `STOUT_REMOTE_TOKEN` | unset | Optional **external Git remote** (e.g. GitHub) the server pulls-from/pushes-to on its sync loop, merging divergent history at the boundary. Server-side secret; clients are unaware. Default = internal bare repo only. |
| `STOUT_HUB_URL` / `STOUT_HUB_BRANCH` | unset | Electron-only hub sync. The hub token lives in the OS keychain, not the environment. |

## Deploy

The production artifact is a **single app container** (see [`Dockerfile`](Dockerfile)): a Node 22 slim image that builds the monorepo, installs `git`, and runs `node apps/server/dist/index.js`, serving the built React SPA and the `/api/*` surface.

```bash
# Build and tag the image
docker build -t stout:latest .

# Run against a reachable Postgres (pgvector), persisting the note repo on a volume
docker run -d --name stout \
  -p 3000:3000 \
  -e DATABASE_URL="postgres://user:pass@your-db-host:5432/postgres" \
  -e STOUT_DB_NAME=stout \
  -e STOUT_DATA_DIR=/data \
  -e PORT=3000 \
  -v stout-data:/data \
  stout:latest
```

Deployment notes:

- Point `DATABASE_URL` at a Postgres instance that has `pgvector` available; the server enables the extension and runs migrations on startup.
- Mount a durable volume at `STOUT_DATA_DIR` (`/data`) so the note Git repository survives restarts.
- To make an external GitHub repo the source of truth, set `STOUT_REMOTE_URL`/`STOUT_REMOTE_TOKEN` (the token is a server-side secret — inject it via your platform's secret manager, never bake it into the image).
- The container exposes port `3000`; place it behind your reverse proxy / TLS terminator.

The PWA is part of the same SPA build (`dist/sw.js` + `dist/manifest.webmanifest`): once deployed over HTTPS the web app is installable and works offline against an in-browser IndexedDB clone.

## License

This project is private/unreleased; no license is granted at this time.
