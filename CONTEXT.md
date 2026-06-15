# Stout — Domain Context

The shared language for Stout. When code, issues, tests, or docs name a domain
concept, use the term as defined here rather than a synonym.

Stout is a git-backed Markdown note app: every note is a plain Markdown file in a
git repository the user controls, presented to the user as a single hierarchy.

## Glossary

### Note tree

The single unified hierarchy of notes the user sees. There is no separate notion
of "files vs folders" — the tree is the one navigation structure, rendered in the
left navigation panel. Produced by the pure `core/note-tree` mapper from the set
of Markdown files in the working clone. A note's **identity** is its `path` in
the tree (its repo path minus the `.md` extension and any trailing `_index`).

### Leaf note

A note with no children, backed by a regular `name.md` file. Its **title**
derives from the file name (`my-ideas.md` → "My Ideas").

### Parent note

A note that can contain children. It is a directory containing an `_index.md`;
that directory may also hold child notes. A parent note still has its own content
(in the `_index.md`) — "folders are first-class notes, not empty containers". Its
**title** derives from the folder name. The repository root is itself a parent
note, backed by the root `_index.md`.

A **leaf↔parent transition** (giving a leaf note its first child, or removing a
parent's last child) is a single `git mv` that preserves the note's `path`
identity. (Transitions land in a later slice; the identity model that makes them
cheap is established now.)

### `_index.md`

The conventional file name that makes a directory a parent note and holds that
parent note's own content. It is the parent's backing file, never a child note
named "_index".

### Working clone

The checked-out git clone (`<STOUT_DATA_DIR>/clone`) that the server reads and
edits. `core/git-engine` reads the working clone; the note-tree mapper turns the
files it lists into the note tree.

### Bare repo

The canonical git store (`<STOUT_DATA_DIR>/repo.git`) — a bare repository that is
the single source of truth and the (future) git remote clients sync against. On
first boot the server initializes the bare repo, clones a working clone from it,
seeds a starter `_index.md`, and pushes that seed back to the bare repo.

### Git engine

The deep module (`core/git-engine`) that reads the working clone. The contract
(`GitEngine.listNoteFiles`, `readNoteTree`) lives in `@stout/core`
(runtime-agnostic); the Node implementation that touches the filesystem and the
`git` binary (`NodeGitEngine`, `ensureWorkspaceRepo`) lives in `apps/server`.

### Health status

Walking-skeleton liveness contract returned by `GET /api/health`: service status,
database reachability, and current migration version.

## Boundaries

- **`@stout/core` is pure** — runtime-agnostic domain logic only, no Node/DOM/git
  imports. The note-tree mapping is a pure function here; the git engine is an
  interface here. The Node/git side lives in `apps/server`.
- **Git is the single source of truth.** Postgres (vector index + derived
  metadata) is disposable and rebuildable from the repo; it is never canonical.
