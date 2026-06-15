# Stout — Product Requirements Document

> Stout is a high-fidelity, interlinked note-taking application for power users who value
> portability, privacy, and technical rigor. It pairs a WYSIWYG markdown editor with a unified
> note tree, git-backed versioning/sync, and semantic search — built on open formats (Markdown,
> Git, vectors) so there is no vendor lock-in.

## Problem Statement

Power users who treat notes as a "second brain" are forced to choose between three things they
should not have to trade off:

- **Portability & ownership** — most polished note apps store content in proprietary formats or
  cloud databases, creating lock-in and privacy concerns.
- **A refined editing experience** — plain-text/markdown tools that *are* portable often feel
  raw, and tools that feel great are usually closed.
- **Working everywhere, including offline** — users move between a desktop and a phone, and
  expect their notes to be available and editable without a constant connection.

They also want version history they can trust and search that understands meaning, not just
keywords — without surrendering their data to a third party.

## Solution

Stout stores every note as a plain Markdown file in a Git repository that the user self-hosts.
A single Node service hosts the web application, a REST domain API, and the Git remote itself;
the same UI runs in Electron (desktop, local-first) and in the browser/PWA (mobile and web).
Git is the single source of truth; a server-side vector index (rebuildable from the repo at any
time) powers semantic search. Editing happens in a WYSIWYG surface that always writes canonical
Markdown, so history stays clean and the files remain openable anywhere.

The experience is unified: the user sees one hierarchy of notes (folders are just notes that have
children), edits autosave continuously with meaningful version history, and changes synchronize
across devices through Git — with conflicts resolved automatically and without data loss.

## User Stories

1. As a power user, I want my notes stored as plain Markdown files, so that I am never locked into a proprietary format.
2. As a privacy-conscious user, I want to self-host the entire service in a container, so that my notes never leave infrastructure I control.
3. As a desktop user, I want a local-first Electron app with a real local Git clone, so that I can read and edit my notes with full speed and offline.
4. As a mobile user, I want an installable PWA, so that I can access my notes on my phone without a separate native app.
5. As a mobile user, I want an offline cache of my notes in the browser, so that I can read and edit even with no connection and sync later.
6. As a web user, I want the same UI regardless of whether I am in Electron or a browser, so that the experience is consistent everywhere.
7. As a user, I want a single unified hierarchy of notes, so that I don't have to think about the distinction between files and folders.
8. As a user, I want any note to be able to contain child notes, so that I can organize my thinking into arbitrary depth.
9. As a user, I want a note with children to keep its own content, so that "folders" are first-class notes, not empty containers.
10. As a user, I want to move or rename a whole subtree in one action, so that reorganizing is fast and safe.
11. As a writer, I want a WYSIWYG editor, so that I can focus on content without reading raw markup.
12. As a writer, I want to experiment with different editor engines over time, so that I'm not permanently locked into one editing surface.
13. As a writer, I want real-time rendering of checkboxes and formatting, so that my notes look like finished documents as I type.
14. As a note-taker, I want `[[Note Name]]` wikilinks, so that I can interlink my notes into a knowledge graph.
15. As a note-taker, I want link autocomplete while typing `[[`, so that I can quickly reference existing notes.
16. As a note-taker, I want to navigate to a linked note by clicking it, so that I can move through my graph fluidly.
17. As a note-taker, I want broken links surfaced, so that I can keep my graph healthy.
18. As a user, I want YAML frontmatter for tags, title, and dates, so that I can attach structured metadata to notes.
19. As a user, I want tags shown as chips on a note, so that I can see a note's classification at a glance.
20. As a user, I want to embed images and attachments stored in the repo, so that my notes are self-contained and portable.
21. As a user, I want my edits autosaved continuously, so that I never lose work.
22. As a user, I want autosave to happen quietly in the background, so that saving never interrupts my flow.
23. As a user, I want my Git history to be meaningful, so that I get one clean commit per editing session rather than thousands of keystroke commits.
24. As a user, I want in-progress autosaves kept safely until a session ends, so that a crash never loses my work.
25. As a multi-device user, I want my notes to synchronize across devices automatically, so that I always see my latest content.
26. As a multi-device user, I want sync to happen on launch, on reconnect, on focus, and periodically, so that I don't have to think about syncing.
27. As a user, I want a manual "sync now" option, so that I can force synchronization when I want.
28. As a multi-device user, I want overlapping edits auto-merged when possible, so that simultaneous changes just work.
29. As a multi-device user, I want conflicting edits preserved as a copy rather than overwritten, so that I never lose data in a conflict.
30. As a user, I want a gentle, non-blocking notification when a conflict copy is created, so that I can reconcile it later without being interrupted.
31. As a user, I want semantic/vector search across all my notes, so that I can find content by meaning, not just keywords.
32. As a user, I want search to work offline by falling back to keyword/filename matching, so that I can still find notes without a connection.
33. As a privacy-conscious user, I want embeddings generated locally on my own server, so that note content is never sent to a third party.
34. As a user, I want the search index rebuildable from my repo, so that I can trust Git as the only source of truth.
35. As a self-hoster, I want the service to run in a single app container, so that deployment is simple.
36. As a self-hoster, I want to point the service at my existing Postgres, so that I don't run a redundant database.
37. As a self-hoster, I want the service to manage its own database schema and vector extension, so that setup is automatic.
38. As a self-hoster, I want one configured password to protect the web app, REST API, and Git transport, so that access control is simple and unified.
39. As a self-hoster, I want the service to initialize a starter repo on first boot, so that I can begin using it immediately.
40. As a multi-device user, I want to add a new device with just a server URL and token, so that onboarding a device is trivial.
41. As an advanced user, I want to optionally point the source-of-truth repo at an external remote like GitHub, so that I can use existing infrastructure as my canonical store.
42. As an advanced user, I want clients to remain unaware of the external remote, so that switching the backing store changes nothing about how I use the app.
43. As a user, I want a three-panel workspace (navigation, editor, contextual utilities), so that I can browse, write, and reference simultaneously.
44. As a mobile user, I want a focused single-column layout, so that the editing experience stays usable on a small screen.
45. As a user, I want my notes to remain pristine, diff-friendly Markdown, so that version history is readable and merges are reliable.

## Implementation Decisions

**Architecture & topology**
- Git is the single source of truth. Electron is a full local-first Git client; the web/PWA is an online client with an offline cache. (Mobile is the PWA — there is no native mobile app and no Electron-on-mobile.)
- Clients access storage through a single high-level **domain interface** (`getNote` / `saveNote` / `getTree` / `search`), implemented by per-runtime storage adapters (Node-fs/local-git, browser/IndexedDB, server). The UI is identical across runtimes.
- A shared `@stout/core` TypeScript package holds all domain logic; thin adapters wire it to each runtime. The server is Node/TypeScript so `core` runs unchanged on both client and server.

**Modules**
- `core/note-tree` (deep, pure): maps repo files ↔ a unified note tree; path/title is identity; a note with children is a directory containing `_index.md` (title derived from the folder name); leaf↔parent transitions are single `git mv` operations.
- `core/markdown` (deep, pure): canonical CommonMark+GFM serialization on every write, YAML frontmatter parsing, and `[[wikilink]]` resolution + link-graph/broken-link detection.
- `core/git-engine` (deep): `isomorphic-git` over a pluggable filesystem backend (Node `fs`, browser `lightning-fs`/IndexedDB, server `fs`) — clone, commit, squash, merge, push, pull.
- `core/sync` (deep): wip-branch lifecycle, squash triggers, sync cadence, and the conflict policy.
- `core/search-index` (deep): note chunking → embeddings → query/rank; interface in core, pgvector implementation on the server with a locally-run embedding model.
- `storage-adapter` (seam): domain-interface implementations per runtime.
- `editor` (seam): TipTap (ProseMirror) behind a swappable `Editor` contract (`value: markdown` in, `onChange(markdown)` out, plus link-autocomplete/navigation events).
- `server` (shell): web host + REST API + Git smart-HTTP remote + indexer + auth + migrations.
- `apps/electron` (shell): Electron shell wiring the Node-fs/local-git adapter.

**Versioning & sync**
- Debounced per-note auto-commit (~3s idle). Autosave commits land on an ephemeral local `wip/<note>` branch, squash-merged into `main` on focus-leave (with idle / pre-sync / quit safety nets). WIP branches are never pushed; only `main` syncs.
- Sync (pull → merge → push) runs on launch, on reconnect, on focus, on a periodic timer, and via manual trigger.
- Conflict policy: auto-merge non-overlapping changes; on a true conflict, keep the incoming `main` version as the file and write the local version to a sibling conflict-copy note, then surface a non-blocking notification. Zero data loss; no raw conflict markers shown.

**Editor & format**
- WYSIWYG via TipTap, writing canonical CommonMark+GFM so the same logical content always produces byte-identical Markdown regardless of editor engine — keeping diffs minimal and line-level merges viable.

**Server, hosting & data**
- Single-user, single repo, self-hosted. One Node server is simultaneously the web host, REST API, and Git smart-HTTP remote (bare repo + working clone), all same-origin.
- The server is always the sync hub. An external remote (e.g., GitHub) is server-side configuration; clients are unaware of it. When external, the server performs a merge step at that boundary.
- Deployment: a single app container (Node + in-process embedding model + `/data` volume for repo/clone) connecting to an **external** Postgres. Stout uses a dedicated `stout` database, runs its own migrations, and enables the `vector` extension on boot. Postgres holds only the vector index + derived metadata — it is disposable and fully rebuildable from the repo; Git remains canonical.
- Auth: one configured password → HTTP-only session cookie for browser/PWA, and a long-lived token (OS keychain in Electron) used as Git HTTP basic-auth and Electron REST auth. HTTPS assumed in production.

**Lifecycle**
- On first boot the server initializes the bare repo + working clone (with a starter note), enables the DB/extension, and prompts for the password. Clients only ever clone-then-sync with URL + token. Importing an existing repo is handled as its own concern.

**Build topology**
- pnpm + Turborepo monorepo: `packages/core`, `packages/ui`, `apps/electron`, `apps/server`. Vite for web/renderer bundling.

## Testing Decisions

**What makes a good test:** Tests assert external, observable behavior through a module's public
interface — given inputs produce expected outputs/effects — not internal implementation details.
This keeps tests stable across refactors and makes the deep modules safe to evolve.

**Modules to be tested in isolation** (the five deep modules, which hold the tricky, rarely-changing logic and have clean inputs/outputs):

- `core/note-tree`: round-tripping files ↔ note tree; leaf↔parent (`_index.md`) transitions; subtree move/rename; title derivation; path/title identity.
- `core/markdown`: canonical serialization idempotency (serialize→parse→serialize is byte-stable); frontmatter parsing; `[[wikilink]]` resolution and broken-link detection.
- `core/git-engine`: clone/commit/squash/merge/push/pull behavior driven against an in-memory FS backend, so Git semantics are validated without a real filesystem or network.
- `core/sync`: wip-branch lifecycle and squash triggers; auto-merge success paths; conflict → keep-both-as-copy outcome (verifying no data loss and correct copy creation).
- `core/search-index`: chunking and ranking behavior behind the index interface, using a stub/local embedding backend so tests are deterministic and offline.

**Prior art:** None yet — this is a greenfield repo (single initial commit). These deep-module
unit tests establish the testing pattern: pure-logic modules (`note-tree`, `markdown`) tested
directly; FS/Git-touching modules (`git-engine`, `sync`) tested against in-memory/stub backends;
`search-index` tested with a deterministic stub embedder. Adapters, the server shell, and the
Electron shell are intentionally thin and are not the focus of unit testing in this PRD.

## Out of Scope

- **Multi-user / multi-tenancy**, sharing, and permissions — v1 is single-user, single-repo.
- **Native mobile apps** (Capacitor/Tauri/React Native) — mobile is the PWA only.
- **Client-side embeddings / offline semantic search** — offline degrades to keyword/filename search; semantic search is server-side and online-only.
- **In-UI merge/diff resolution view** — conflicts are auto-handled via keep-both-as-copy; a manual merge UI is a possible future addition.
- **CRDT / real-time collaborative editing** — not part of the Git-based model in v1.
- **Importing an existing external repo** at first-run — acknowledged as a separate effort.
- **Multiple repos / workspaces** per user — deferred; a repo is a directory, so this is an easy later addition.
- **External embedding APIs** (e.g., third-party) — rejected for privacy; embeddings run locally.
- **Bundling/managing Postgres** — Postgres is an external dependency the operator provides.

## Further Notes

- **Sequencing (v1 tracer bullet):** build the **server + browser web app** vertical first
  (create/edit notes → canonical markdown → auto-commit/squash → server-side Git → reindex →
  semantic search → render). Then layer on, in order: (2) Electron + local-git adapter,
  (3) PWA offline via `isomorphic-git`/IndexedDB + the conflict-copy machinery (which only earns
  its keep with 2+ clients), (4) external-remote/GitHub config, (5) import.
- **isomorphic-git deferral:** the full offline browser client is intentionally deferred to step 3.
  Because `core/git-engine` abstracts the FS backend, moving Git into the browser later is a
  backend swap behind the stable domain interface rather than a new integration.
- **Prerequisite:** the operator's external Postgres must be able to load the `pgvector`
  extension. If it cannot, the server-side index would need to fall back to an embedded vector
  store — out of scope here but worth noting for deployment.
- **UI surfaces not yet drilled:** the three-panel layout + right-hand utilities (calendar /
  table of contents / metadata) and the search-results / settings screens sit cleanly on top of
  this architecture and were deliberately left at PRD-feature level.
- **Design system:** the existing "Technical Umber" design system (see `DESIGN.md`) governs the
  visual language.
