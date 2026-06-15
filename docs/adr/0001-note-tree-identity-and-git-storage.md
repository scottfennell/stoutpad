# 1. Note-tree identity model and git storage

- Status: Accepted
- Date: 2026-06-15
- Issue: #3 (First-boot repo init + read note tree)

## Context

Stout presents notes as a single unified hierarchy ("folders are just notes that
have children") while storing every note as a plain Markdown file in a git
repository the user controls. This slice has to decide two things:

1. **Identity model** — how a flat set of repository files maps to the note tree,
   and how a note keeps a stable identity whether it is a leaf or a parent.
2. **Git storage / engine** — how the server materializes the repository on first
   boot and reads it, given the constraints: keep `@stout/core` pure
   (runtime-agnostic, no Node/DOM), keep the engine injectable/testable, and ship
   in a single slim Node container.

The PRD names `core/note-tree` (pure: files ↔ note tree, `_index.md` parents,
path/title identity) and `core/git-engine` (`isomorphic-git` over a pluggable FS
backend), with the full git machinery (clone/commit/squash/merge/push/pull,
browser backend) explicitly deferred to later slices.

## Decision

### Identity model (`core/note-tree`, pure)

- A **leaf note** is backed by a regular `name.md` file; its title derives from
  the file name.
- A **parent note** is a directory containing an `_index.md`; its title derives
  from the folder name, and its content lives in the `_index.md`. The repo root
  is a parent note backed by the root `_index.md`.
- A note's **identity is its tree `path`**: the repo path with the `.md`
  extension and any trailing `_index` removed (root = `""`). This makes a
  future leaf↔parent transition a single identity-preserving `git mv`.
- Titles are derived from the path segment (drop `.md`, split on `-`/`_`/space,
  capitalize words). Frontmatter/`[[wikilink]]` parsing is `core/markdown`'s job
  (a later slice) and deliberately not read here.
- The mapper is a **pure function** (`buildNoteTree(files) → root NoteNode`):
  deterministic, order-independent, ignores non-`.md` files, and synthesizes
  implied parents for nested files lacking an `_index.md`. It is unit-tested in
  isolation against file-set inputs.

### Git storage + engine

- On first boot the server initializes a **bare repo** (`repo.git`, the canonical
  store / future remote) and a **working clone** (`clone`) seeded with a starter
  `_index.md`, then pushes the seed to the bare repo. Storage lives under
  `STOUT_DATA_DIR` (default `data`, `/data` volume in the container).
- The read seam (`GitEngine.listNoteFiles`, `readNoteTree`) is defined in
  `@stout/core` and stays pure. The Node implementation that touches the
  filesystem and git (`NodeGitEngine`, `ensureWorkspaceRepo`) lives in
  `apps/server`.
- For this slice the Node engine **shells out to the system `git`** rather than
  adding a git library. Rationale: local bare/clone/commit/push and `ls-files`
  are first-class in the CLI, it adds zero dependencies, and the operations we
  need (a local bare↔clone with push/pull between file paths) are awkward with
  `isomorphic-git`, which is transport/HTTP-oriented. The slim runtime image
  installs `git`.
- The engine is wired into the HTTP layer as an injected dependency
  (`createApp({ getTree })`) and exposed at `GET /api/tree`
  (`TREE_PATH`/`NoteTreeResponse`), mirroring the existing `getHealth` seam, so
  the endpoint is tested with a fake and the engine is tested against a real git
  repo in a temp dir (offline).

## Consequences

- The pure mapper is fast, deterministic, and trivially unit-tested; the tricky
  rarely-changing logic lives behind a clean file-set → tree contract.
- The note-tree identity model is locked in: leaf↔parent transitions, subtree
  move/rename, and title derivation (later slices) build on a stable `path`
  identity.
- Shelling out to `git` requires the binary at runtime (added to the Docker
  runner image; assumed present in dev/CI). The repository read currently lists
  **tracked** files (`git ls-files`); uncommitted working-tree notes are out of
  scope until the editor/auto-commit slice.
- Because the read contract lives in `@stout/core`, swapping the engine to
  `isomorphic-git` (per the PRD, e.g. for the browser/IndexedDB FS backend) is a
  backend swap behind the same interface, not a new integration — consistent with
  the PRD's deferral of the full git engine.
- Git remains the single source of truth; the note tree is always rebuildable
  from the repo.
