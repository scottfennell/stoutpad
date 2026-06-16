# 7. Frontmatter, tag chips, and attachments

- Status: Accepted
- Date: 2026-06-16
- Issue: #9 (Frontmatter, tag chips & attachments)

## Context

Notes so far carry only their Markdown body. Two related gaps remain before a
note feels complete:

1. **Structured metadata.** Users expect a note to carry a `title`, `tags`,
   and timestamps — the YAML **frontmatter** block (`---`-fenced) that every
   Markdown notes app understands. Tags in particular should render as **chips**
   at the top of a note, and a frontmatter `title` should override the title the
   note tree otherwise derives from the file name (ADR 0001).
2. **Embedded media.** A note should be able to embed an image. To keep notes
   **self-contained and portable** (the git repo is the single source of truth),
   an embedded image must be a real file *in the repository*, referenced by a
   repo-relative path — not an external URL or an inline data blob.

This crosses every layer, so several things need deciding:

- **How frontmatter is parsed** without pulling a YAML dependency into pure
  `@stout/core`, and without breaking the **canonical Markdown** round-trip
  (ADR 0003): a note with no frontmatter must still serialize byte-for-byte as
  before.
- **Where the title override lives** so the note tree and the center panel agree.
- **How an attachment is uploaded, stored, and committed**, and how it is
  referenced from and rendered in the editor.
- **How the editor handles frontmatter** — it renders a note *body*, and must
  never show or clobber the raw `---` block.

## Decision

### Frontmatter is a tiny YAML subset parsed in `core/markdown`

- `parseMarkdown` splits an optional leading `---`-fenced block off the front
  (`parseFrontmatter`) and parses the remaining body into the existing block
  model. The result type grows an **optional** `frontmatter?` field: a note with
  no frontmatter keeps the bare `{ blocks }` shape it had before, so every
  existing round-trip test holds unchanged.
- The parser recognizes a deliberately **small subset** — no nested maps, no
  anchors — so it stays pure and dependency-free: `title`, a `tags` list (flow
  `[a, b]` or block `- a` form), `created` / `updated` dates (kept **verbatim**
  as strings), and any other `key: value` scalars preserved in `extra` so unknown
  fields round-trip untouched.
- `serializeMarkdown` accepts either a `MarkdownDocument` or a bare block array,
  and when given non-empty frontmatter emits a **canonical** `---` block first
  (fixed key order: `title`, `created`, `updated`, sorted `extra`, then `tags`),
  one blank line before the body. Serialization stays **deterministic and
  idempotent**, so frontmatter round-trips through the same canonicalization as
  the body — the ADR 0003 promise now covers metadata too.

### A frontmatter `title` overrides the derived note-tree title

`core/note-tree` gains an optional `NoteFile.title`; when present it overrides
the file-name-derived title for both leaf and parent notes. The Node read path
(`readNoteTree` in `core/git-engine`) parses each note's frontmatter and threads
the `title` through. The override is **display-only** — a note's `path` identity
and its wikilink **title** (ADR 0006) still derive from the file name — so adding
a frontmatter title cannot silently break inbound links or move a note.

### Attachments are real repo files under `assets/`, uploaded as base64 JSON

- An embedded attachment is stored as a real file under a conventional
  `assets/` folder (`ASSETS_DIR`) in the working clone and referenced from
  Markdown by its repo-relative path: `![alt](assets/diagram.png)`. The note
  stays portable — clone the repo and the images come with it.
- Upload is a plain JSON `POST /api/attachment` (`ATTACHMENT_PATH`): the bytes
  travel **base64-encoded** (`AttachmentUploadRequest { name, dataBase64 }`) so
  there is no multipart handling. The pure pieces — the path/contract, the
  `name → safe slug` function (`slugifyAttachmentName`, extension preserved), and
  the `writeAttachment` composition over a narrow `AttachmentGitEngine` seam —
  live in `core/attachment`, mirroring how `writeNote` sits over
  `WritableGitEngine`. The server's `NodeGitEngine.writeAttachmentFile` decodes,
  writes, and **commits to `main`**, owning **collision resolution** (a `-1`,
  `-2`, … suffix) since uniqueness depends on what is already on disk. It returns
  the **final** stored path, which the client embeds.
- Stored attachments are served statically from a `/assets` mount, so the
  repo-relative `assets/x.png` is loadable in the browser at `/assets/x.png`.

### The editor renders a note *body*; frontmatter is a header, images are live nodes

- The center panel **splits frontmatter off** before handing Markdown to the
  Editor seam: the editor only ever sees the frontmatter-free body, and the
  metadata is rendered as a **header** (the display title + the tags as chips).
  On change, the panel **recombines** the unchanged frontmatter with the edited
  body before driving the autosave session (ADR 0004), so metadata survives a
  round-trip through an editor that never knew about it. The seam contract
  ("Markdown in, change events out", ADR 0002) is unchanged.
- The pure Markdown↔ProseMirror bridge maps a **standalone** `![alt](src)`
  paragraph to a live TipTap `image` node and back, translating the stored
  `assets/x.png` path to the hosted `/assets/x.png` URL for display and back to
  the repo-relative path on serialize. The default editor registers
  `@tiptap/extension-image` so the node renders as a real `<img>`. Uploading an
  attachment appends such an image block to the body, which the editor then
  renders in place.

## Consequences

- **Frontmatter is unit-tested purely, offline.** The `parseFrontmatter` subset,
  the canonical frontmatter serialization, and the title override are tested as
  pure functions; the attachment slug + `writeAttachment` composition are tested
  against an in-memory engine double, mirroring the existing seam tests. No live
  YAML parser, server, or repo is needed.
- **No frontmatter, no change.** Because `frontmatter?` is optional and the
  serializer emits nothing for an empty/absent block, notes without metadata are
  byte-identical to before — the round-trip and idempotence guarantees of ADR
  0003 are preserved, as are all prior tests.
- **The YAML subset is intentionally narrow.** Nested maps, anchors, and block
  scalars are not supported; unrecognized scalars survive in `extra` but exotic
  YAML would be lossy. This keeps `@stout/core` dependency-free and the format
  human-writable; richer YAML is a later slice if ever needed.
- **Attachments keep notes portable and git-native.** An embedded image is a
  committed repo file, not an external link or a bloated inline blob, so notes
  stay self-contained and diffs stay meaningful. The trade-off is that pasting an
  image is an explicit upload + commit, and binary blobs live in git history.
- **Embedded-image support is image-*only* paragraphs for now.** Only a paragraph
  that is nothing but `![alt](src)` becomes a live image node; an image mixed into
  a line of prose stays literal Markdown. Inserting an attachment appends it to
  the end of the body rather than at the caret. Both are deliberate scope limits
  that keep the pure bridge simple and round-trippable; richer inline placement is
  a later slice.
- **Title coupling stays at the file name.** The frontmatter title is display
  only, so wikilink resolution (ADR 0006) and note identity (ADR 0001) are
  unaffected — adding or changing a `title:` never breaks links or changes a
  note's `path`.
