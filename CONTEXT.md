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
derives from the file name (`my-ideas.md` → "My Ideas"), unless its
**frontmatter** sets a `title`, which overrides the derived one.

### Parent note

A note that can contain children. It is a directory containing an `_index.md`;
that directory may also hold child notes. A parent note still has its own content
(in the `_index.md`) — "folders are first-class notes, not empty containers". Its
**title** derives from the folder name (or its `_index.md` **frontmatter**
`title`, which overrides it). The repository root is itself a parent note, backed
by the root `_index.md`.

A **leaf↔parent transition** keeps a note's `path` identity stable as it gains or
loses children. **Promotion**: giving a leaf its first child turns `Foo.md` into
`Foo/_index.md` (a single `git mv`) so the child has somewhere to live.
**Collapse**: the symmetric inverse — removing a parent's *last* child turns
`Foo/_index.md` back into `Foo.md`. Collapse is **automatic** (a parent that
loses its last child becomes a leaf again) but never applies to the repository
root, which is always a parent. Promotion and collapse are exact inverses,
computed by the **note mutation** planner.

### `_index.md`

The conventional file name that makes a directory a parent note and holds that
parent note's own content. It is the parent's backing file, never a child note
named "_index".

### Note mutation

A change to the note tree's *shape* (as opposed to a note's content): **create** a
new note, **rename** a note in place, or **move** a note under a different parent.
Each carries the **leaf↔parent transition** automatically (promotion on a parent's
first child, collapse on its last) and, for a parent, moves its whole subtree as
one directory rename. Planned purely by `core/note-mutation` (current files +
operation → a `NoteMutation`: the backing-file `moves`/`creates`/`removes` plus
the resulting identity), then applied by the **git engine** as **one atomic
commit** on `main` (all-or-nothing; a failure rolls back). Exposed as three verbs
— `POST /api/note/create`, `/api/note/rename`, `/api/note/move` — each returning
the affected note's new `path`/`file`; an invalid name, a colliding target, or
moving a note into its own subtree is a `NoteMutationError` (HTTP 400). Names
become safe kebab-case file slugs via `slugifyNoteName`.

### Canonical Markdown

A note's content is plain **Markdown** — the text of its backing file — and that
Markdown is the *canonical* representation. Everything richer (the editor's
document model, rendered HTML) is derived from it and serialized back to Markdown
on edit; Markdown is what git stores and what `GET /api/note`
(`NOTE_PATH`/`NoteContentResponse`) returns, keyed by the note's `path` identity.
The pure `core/markdown` parser turns it into a small block model (headings,
paragraphs, bullet lists, and checkbox **task lists**) without touching the DOM,
and its inverse `serializeMarkdown` renders that model back to **canonical**
CommonMark + GFM. "Canonical" is a strong promise: serialization is
**deterministic** (same model → same bytes) and **idempotent** (re-parsing and
re-serializing is byte-stable), so the same logical content always lands as the
same file and edits produce small, meaningful git diffs.

### Frontmatter

The optional `---`-fenced YAML block at the top of a note's **canonical
Markdown**, carrying structured metadata: a `title` (which overrides the note's
file-name-derived **title**, display-only — it never changes the note's `path`
identity or its wikilink title), a `tags` list (rendered as **chips** at the top
of the note), `created` / `updated` dates (kept verbatim), and any other scalar
fields (preserved so they round-trip). Parsed by `core/markdown` as a
deliberately tiny YAML subset (no nested maps/anchors, so `@stout/core` stays
dependency-free) into an optional `frontmatter` on the parsed document; a note
with no frontmatter keeps the bare block shape it had before, and the canonical
serializer emits a fixed-order block only when frontmatter is present — so
**Canonical Markdown**'s round-trip and idempotence promises extend to metadata.
The editor never sees frontmatter: the center panel splits it off, renders it as
a header (title + tag chips), and recombines it with the edited body on save.

### Attachment

An embedded binary file (e.g. an image) stored as a real file in the repo — under
a conventional `assets/` folder — and referenced from a note's **canonical
Markdown** by its repo-relative path (`![alt](assets/diagram.png)`), so notes
stay self-contained and portable. Uploaded via `POST /api/attachment`
(`ATTACHMENT_PATH`) as a plain JSON body with the bytes base64-encoded (no
multipart); the server decodes, writes, and commits the file to `main` via the
**git engine**, resolving any name collision with a unique suffix and returning
the **final** stored path. The pure pieces — the contract, the `name → safe slug`
function, and the `writeAttachment` composition over the narrow
`AttachmentGitEngine` seam — live in `core/attachment`, mirroring how
**commit-on-save**'s `writeNote` sits over `WritableGitEngine`. Stored
attachments are served statically from `/assets`, and the editor renders a
standalone `![alt](assets/…)` image paragraph as a live image (translating the
stored path to the hosted `/assets/…` URL and back).

### Commit-on-save

Persisting an edit is a git commit. `POST /api/note`
(`NOTE_PATH`/`NoteSaveRequest`) takes the editor's Markdown, runs it through the
canonical serializer, writes the note's backing file in the **working clone**,
and commits it to `main` via the **git engine** — one commit per save. A save
that produces no change is a no-op (no empty commit), so commit-on-save is
idempotent at the git level too. Reloading the note (`GET /api/note`) reflects
the committed content, and `git log` shows the commit. (`POST /api/note` is the
explicit-save verb; continuous editing now goes through **Autosave & squash**,
which layers on top of the same canonicalize-and-commit machinery but targets a
**WIP branch** instead of `main`.)

### Editing session

One note's continuous-edit lifecycle: it begins when a note is loaded for editing
and ends on a **session-end** signal — focus leaving the note (tab blur, hiding,
unload, or switching notes), an idle timeout, or the app quitting. Within a
session, edits are buffered and autosaved to the note's **WIP branch**; ending
the session squashes that branch into one `main` commit. So `main` carries one
meaningful commit per editing session, not one per keystroke. Orchestrated by the
pure `core/sync` state machine (`NoteSync`), which owns no real timer or git — it
is driven through explicit `onEdit` / `tick` / `flush` / `onFocusLeave` /
`onIdle` / `onQuit` calls against an injected clock and **wip engine**.

### WIP branch

An ephemeral, local-only Git branch (`wip/<note>`, e.g. `wip/root` for the root
note) that holds a single editing session's in-progress autosave commits. Because
the autosaves are real commits, in-progress work survives a reload or crash. WIP
branches live only on the **working clone** and are **never pushed** — the sync
seam exposes no push operation, so this holds by construction. A WIP branch is
squash-merged into `main` and deleted when its session ends. An orphan WIP branch
left by a crash is preserved (never silently deleted) and folds into the next
editing session's squash.

### Autosave & squash

The two-phase persistence of an **editing session**. *Autosave*: a buffered edit
is canonicalized and, after a debounce interval (~3s idle), committed onto the
note's **WIP branch** (a no-op edit that reverts to the last saved content commits
nothing). *Squash*: on session-end the WIP branch is squash-merged into `main` as
one plain (non-merge) commit with a sensible message, then deleted. The pure
machine lives in `core/sync`; in the browser it drives the wip engine over HTTP
(`POST /api/note/sync`, actions `autosave` / `squash` / `delete-wip`, dispatched
server-side by `applyNoteSync`), and the server's `NodeGitEngine` performs the
real git. Builds on **Commit-on-save** (same canonical serializer + backing-file
resolution); the difference is *where* and *how often* commits land.

### Editor seam

The swappable contract through which the center panel renders a note: **Markdown
in, change events out**. Any component honoring it (`EditorComponent` in
`@stout/ui`) can be dropped in; the default is a **TipTap** implementation that
renders live formatting and checkboxes. The seam keeps the rich editor (TipTap /
ProseMirror, DOM-bound) out of `@stout/core`, mirroring how the git engine keeps
Node out of core.

### Wikilink

An inter-note reference written `[[Note Name]]` (or `[[Note Name|alias]]`) in a
note's **canonical Markdown**. A wikilink targets a note by its **title**, not its
`path`: it **resolves** to whichever note bears the matching title (normalized —
trimmed, internal whitespace collapsed, case-insensitive), or to nothing. A
wikilink that matches no note is a **broken link** — a surfaced, first-class state
(the editor flags it), not an error. Because resolution depends on the whole note
tree, a link can break or re-resolve as notes are renamed or moved; the rare
ambiguous title (two notes sharing one) resolves deterministically to the first in
tree order. Parsing the `[[…]]` syntax is `core/markdown` (`parseWikiLink` /
`extractWikiLinks`), which keeps the **literal** `[[…]]` text so the note still
round-trips byte-for-byte; resolving a parsed link against the tree is the pure
`core/wikilink` (`buildTitleIndex` / `resolveWikiLink`). In the editor a wikilink
is painted by a **decoration** (never a Markdown rewrite): resolved links are
clickable (navigating to the target note), broken links are styled distinctly, and
typing `[[` opens title **autocomplete**. The editor resolves links client-side
off the already-loaded tree (no fetch); resolution and rendering are decorative
only, so they never perturb the canonical bytes.

### Link graph

The whole-repo set of resolved note→note links, plus the broken links, derived
from every note's wikilinks. Built purely by `core/wikilink`'s `buildLinkGraph`
(extract every wikilink, resolve each against the title index) into deduped,
sorted `edges` (a note linking to another; self-links ignored) and `broken` links
(a target matching no note) — a deterministic function of the notes, so the same
content always yields byte-identical output. Exposed read-only at `GET /api/links`
(`LINKS_PATH` / `LinkGraphResponse`), wired to the `readLinkGraph` git-engine
composition. It is the queryable, whole-repo view of linking (the basis for a
future backlinks panel / graph navigation); the editor does not need it, resolving
links locally off the tree instead.

### Working clone

The checked-out git clone (`<STOUT_DATA_DIR>/clone`) that the server reads and
edits. `core/git-engine` reads the working clone and commits edits to it; the
note-tree mapper turns the files it lists into the note tree. (Pushing the
clone's commits to the **bare repo** — sync — is a later slice; for now edits are
committed on the clone.)

### Bare repo

The canonical git store (`<STOUT_DATA_DIR>/repo.git`) — a bare repository that is
the single source of truth and the (future) git remote clients sync against. On
first boot the server initializes the bare repo, clones a working clone from it,
seeds a starter `_index.md`, and pushes that seed back to the bare repo.

### Git engine

The deep module (`core/git-engine`) that reads and writes the working clone. The
read contract (`GitEngine.listNoteFiles`/`readNoteFile`, `readNoteTree`/`readNote`)
and the write contract (`WritableGitEngine.writeNoteFile`, plus the
canonicalize-then-commit composition `writeNote`) live in `@stout/core`
(runtime-agnostic), as does the narrow **wip engine** seam the autosave machine
drives (`WipSyncEngine`: `commitToWip`/`squashMergeWipToMain`/`deleteWip`, with no
push by design; `WipGitEngine` extends both) and the **note mutation** seam
(`MutatingGitEngine.applyNoteMutation`, which applies a create/rename/move plan as
one atomic commit). The Node implementation that touches the filesystem and the
`git` binary (`NodeGitEngine`, `ensureWorkspaceRepo`) lives in `apps/server`.

### Health status

Walking-skeleton liveness contract returned by `GET /api/health`: service status,
database reachability, and current migration version.

## Boundaries

- **`@stout/core` is pure** — runtime-agnostic domain logic only, no Node/DOM/git
  imports. The note-tree mapping and the `core/markdown` parser are pure functions
  here; the git engine is an interface here. The Node/git side lives in
  `apps/server`, and the rich editor (TipTap/ProseMirror, DOM-bound) lives behind
  the Editor seam in `packages/ui`.
- **Git is the single source of truth.** Postgres (vector index + derived
  metadata) is disposable and rebuildable from the repo; it is never canonical.
