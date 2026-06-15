# 2. Editor seam, canonical Markdown, and the TipTap choice

- Status: Accepted
- Date: 2026-06-15
- Issue: #4 (Open & render a note)

## Context

Selecting a note in the tree opens it in the center panel, where the user reads
and (in later slices) edits it. This slice has to decide:

1. **Read path** — how a note's content is fetched by identity, keeping
   `@stout/core` pure and the Node/Git read an injectable seam (as established for
   the note tree in ADR 0001).
2. **Parsing** — where Markdown is turned into something renderable, given the
   constraint that `@stout/core` stays runtime-agnostic (no DOM).
3. **Rendering** — how the center panel renders a note with live formatting and
   checkboxes, without welding the app to one specific rich-text library.

The PRD names `core/markdown` (pure Markdown helpers) and a center-panel editor
with live formatting and checkbox task lists.

## Decision

### Note-content read contract (`core/note-content`, pure)

- A note is read by its **identity** (its tree `path`; the root note is `""`).
  `GET /api/note?path=<identity>` returns `NoteContentResponse`
  (`{ path, file, markdown }`); the contract (`NOTE_PATH`, the response type, and
  the pure identity → backing-file resolver `noteFileCandidates`) lives in
  `@stout/core`.
- Identity → file resolution is pure: a note is either a **leaf** (`path.md`) or a
  **parent** (`path/_index.md`), root being the repo-root `_index.md`. `readNote`
  (alongside `readNoteTree` in `core/git-engine`) tries each candidate via the
  injected `GitEngine.readNoteFile` and returns the first that exists, or `null`.
- The HTTP layer mounts the endpoint from an injected `getNote` dep
  (`createApp({ getNote })`), wired in prod to `readNote(NodeGitEngine)` and
  returning **404** when the note is missing — mirroring the `getHealth`/`getTree`
  seams, so it is tested with a fake and against a real git repo in a temp dir.
- `NodeGitEngine.readNoteFile` reads the working-clone file by repo path and is
  **path-escape-guarded** (a crafted `path` query can never read outside the
  clone).

### Canonical Markdown + `core/markdown` (pure)

- A note's **Markdown is canonical**: it is what git stores and what the API
  returns. Any richer representation (the editor's document model, rendered HTML)
  is derived from it and serialized back to Markdown on edit.
- `core/markdown` is a **pure, hand-written parser** (`parseMarkdown` → block
  model; `parseInline` → formatted spans), with no Markdown library and no DOM —
  consistent with the repo's preference for small, deterministic, unit-tested deep
  modules (cf. the hand-written `buildNoteTree`). Scope this slice: headings,
  paragraphs, bullet lists, GFM **task lists** (checkboxes), and inline
  `**bold**` / `*italic*` / `` `code` ``. Nested lists are flattened and unknown
  constructs degrade to paragraphs; richer grammar lands later.

### Editor seam + TipTap (`packages/ui`)

- The center panel renders a note through a **swappable Editor seam**: a React
  component with a "**Markdown in, change events out**" contract (`EditorProps`:
  `markdown`, `onChange`, `editable`). The seam (`editor.ts`) also owns the pure
  bridge between canonical Markdown and the editor's ProseMirror-JSON document
  (`markdownToTipTapDoc` / `tipTapDocToMarkdown`), built on top of `core/markdown`.
- The default implementation is **TipTap** (`TipTapEditor.tsx`), chosen because it
  is a maintained, ProseMirror-based React editor with first-class task-list
  (checkbox) and live-formatting support, and a small surface to wrap. Its deps
  (`@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/extension-task-list`,
  `@tiptap/extension-task-item`) live **only in `packages/ui`**; `@stout/core`
  never learns about ProseMirror or the DOM.
- Because rendering is behind the seam, the editor is swappable (e.g. a plain
  textarea, or a future CRDT-backed editor) without touching `@stout/core` — and
  tests can inject a trivial fake editor to verify panel wiring deterministically,
  separately from the TipTap render test.

## Consequences

- The pure pieces (`core/markdown`, `noteFileCandidates`, `readNote`) are fast,
  deterministic, and unit-tested in isolation; the DOM-bound editor is the only
  part that needs a jsdom render.
- Canonical Markdown keeps git as the single source of truth: the editor is a
  view over Markdown, and edits round-trip back to Markdown (the
  `markdownToTipTapDoc`↔`tipTapDocToMarkdown` round-trip is unit-tested).
- TipTap is a real dependency in the UI bundle (and a v3 lockfile entry). Swapping
  it out is a seam-local change; swapping the *parser* is a `core/markdown` change.
  The hand-written parser must grow to cover more Markdown over time, but that
  growth is contained behind `parseMarkdown`.
- The note endpoint currently reads the **working-clone** file (not strictly the
  committed blob), which is the right basis for the upcoming editor/auto-commit
  slice; the read is path-escape-guarded.
