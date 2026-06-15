# 3. Canonical Markdown serialization and commit-on-save

- Status: Accepted
- Date: 2026-06-15
- Issue: #5 (Edit → canonical markdown → commit)

## Context

Opening and rendering a note (ADR 0002) established that **Markdown is
canonical** and the editor is a view over it, with edits emitted back as Markdown
through the **Editor seam**. This slice closes the loop: an edit must *persist* —
the editor's Markdown is written to the note's backing file and committed to git,
and reloading shows the persisted content.

Two things need deciding:

1. **What bytes get written.** TipTap (or any editor behind the seam) can emit
   logically-equivalent Markdown in several shapes (`*`/`-`/`+` bullets, ragged
   spacing, `[X]` vs `[x]`). Writing that verbatim would make git diffs noisy and
   non-deterministic. We want one canonical form per logical document.
2. **How it gets committed.** `@stout/core` must stay pure (no Node/Git), the
   write must be an injectable/testable seam like the read (ADR 0001), and a save
   must produce a real commit on `main`.

The PRD names `core/markdown` (pure Markdown helpers) and git as the single
source of truth with commit-backed edits.

## Decision

### Canonical serializer (`core/markdown`, pure)

- Add `serializeMarkdown(blocks | document)` as the inverse of `parseMarkdown`.
  It emits **canonical CommonMark + GFM**: ATX headings (`#`…`######` + one
  space), one blank line between blocks, `-` bullet markers, `- [x]`/`- [ ]` GFM
  task markers, a single trailing newline (and the empty string for an empty
  note). Inline content is emitted verbatim (the block model already carries
  single-line, normalized text from `parseMarkdown`).
- The promise is strong and unit-tested: serialization is **deterministic** (no
  ambient state) and **idempotent** — `serialize(parse(serialize(x)))` is
  byte-stable, and re-parsing canonical text round-trips. This is what makes
  "same logical content → byte-identical Markdown" true, so saves are
  diff-friendly and replayable.
- Hand-written, no Markdown library — consistent with the existing
  `parseMarkdown`/`buildNoteTree` deep modules.

### Note-save contract (`core/note-content`, pure)

- The single `/api/note` endpoint gains a **write** verb: `POST /api/note` with a
  `NoteSaveRequest` body (`{ path, markdown }`) returns the saved
  `NoteContentResponse` carrying the server's **canonical** Markdown (the client
  adopts it). `GET` reads, `POST` writes; the contract lives in `@stout/core`.
- A missing `markdown` body is a **400**; a missing `path` saves the root note
  (empty-string identity), symmetric with the read endpoint.

### Writable git-engine seam + `writeNote` (`core/git-engine`)

- Extend the read seam with `WritableGitEngine extends GitEngine`, adding
  `writeNoteFile(path, content, message)` — write the file in the working clone
  **and** commit it to `main` in one step. Keeping it behind an interface mirrors
  the `MigrationStore` pattern (ADR/owner: `migrate.ts`): the pure composition is
  tested against an in-memory double, production shells out to real git.
- `writeNote(engine, path, markdown)` is the pure composition: **canonicalize**
  (`serializeMarkdown ∘ parseMarkdown`), resolve the note identity to its backing
  file (preferring the existing file so a parent note writes its `_index.md`;
  defaulting to the leaf `path.md` for a new note — save is an upsert), then
  `writeNoteFile`. Canonicalization and identity→file resolution stay pure; only
  the write/commit touches the engine.
- The Node `NodeGitEngine.writeNoteFile` (in `apps/server`) writes the file
  (`git add` + `git commit`), is **path-escape-guarded** (refuses to write
  outside the clone), and **skips the commit when nothing changed** so a no-op
  save never errors on an empty commit — commit-on-save is idempotent at the git
  level too.

### Commit-on-save semantics

- One save → one commit on the working clone's `main`. Reloading (`GET /api/note`)
  reflects the committed working-clone file (the read basis from ADR 0002), and
  `git log` shows the commit.
- Pushing the clone's commits to the **bare repo** (sync) is deliberately
  **deferred** to a later slice; edits are durable commits on the clone now.

### UI wiring (`packages/ui`)

- The center panel passes the note's `onChange` (Markdown out, per the Editor
  seam) into a debounced `postNote` → `POST /api/note` (`useDebouncedSave`). The
  debounce coalesces keystrokes into one save after a pause; richer
  autosave/squash semantics are a later slice (#6). Loading a different note never
  triggers a save (TipTap re-load uses `emitUpdate: false`).

## Consequences

- The pure pieces (`serializeMarkdown`, `writeNote`) are deterministic and
  unit-tested in isolation; the canonical serializer's idempotency is pinned by a
  byte-stability test over a representative note (headings, bold/italic, bullet +
  task lists). The commit behavior is tested twice: against an **in-memory**
  `WritableGitEngine` (the `MigrationStore`-style double, asserting
  canonicalize-and-commit without git) and against **real git** in a temp clone
  (asserting `git log`/reload), keeping the fast tests offline while still
  exercising the binary.
- Canonical Markdown keeps diffs small and merges sane (foundational for the
  future sync/CRDT slices), at the cost of normalizing some user formatting on
  save (e.g. `+` bullets become `-`). The serializer must grow alongside
  `parseMarkdown` as the grammar widens; both stay behind the one module.
- Save is an **upsert** (creates a missing note's leaf file), which is why `POST`
  has no 404 — note creation flows can reuse it. The leaf↔parent transition and
  explicit create/delete remain later slices on the same identity model.
- The write commits on the working clone only; until the sync slice lands, the
  bare repo holds the seed but not subsequent edits. This is an intentional,
  documented gap, not a regression of "git is the single source of truth" — the
  clone is a real git repo with full history.
