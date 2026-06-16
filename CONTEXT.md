# Stout — Domain Context

The shared language for Stout. When code, issues, tests, or docs name a domain
concept, use the term as defined here rather than a synonym.

Stout is a git-backed Markdown note app: every note is a plain Markdown file in a
git repository the user controls, presented to the user as a single hierarchy.

## Glossary

### Workspace

The whole UI shell: a **three-panel** layout — left **navigation panel** (brand,
"New Note", search, the **note tree**), center **editor panel** (the open note's
header + editor), and right **contextual utilities panel** — that collapses to a
**single focused column** on a narrow viewport, where a bottom tab switcher
chooses which one panel (navigation / editor / context) is shown and opening a
note focuses the editor. Styled by the **Technical Umber** design system
(`DESIGN.md`): one global stylesheet of palette / type / radius / spacing tokens,
imported only at the app entry (`main.tsx`), so the shipped app is themed while
component tests render unstyled and keep asserting on structure, not pixels.
Responsiveness is **pure CSS** with no host branch, so the browser SPA and the
Electron shell render identically — there is no per-runtime layout fork. Fonts are
named-first with a system fallback, so the app never fetches anything at runtime.

### Contextual utilities panel

The right **workspace** panel: everything about the **selected** note, composed
entirely from data the client already holds — its **Details** (the note's
**note-tree** node: identity / backing file / leaf-or-parent kind), its **Outline**
(the heading table-of-contents parsed from the note body), its **Links** (the
note's backlinks / outbound / broken, sliced from the whole-repo **link graph**),
and **System** (the **health status**). It is contextual — empty until a note is
open — and adds no new network traffic beyond the existing `GET /api/links`; its
link rows open notes through the same navigation the tree, search, and wikilinks
use.

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
composition. It is the queryable, whole-repo view of linking — surfaced as the
**contextual utilities panel**'s backlinks / outbound / broken view; the editor
does not need it, resolving links locally off the tree instead.

### Search index

A derived, queryable projection of the notes that powers **search**: every note's
**canonical Markdown** is split into bounded **chunks** (title-aware) and each
chunk is turned into an **embedding** (a vector) by a **locally-run** model on the
server, stored in pgvector. A search **embeds the query** and ranks chunks by
vector (cosine) similarity — **semantic search** — de-duplicated to the best
chunk per note. When semantic ranking is unavailable or empty (no model, the
index is down, or the caller asks for it), search falls back to **keyword search**
— a pure term scorer over note titles, file paths, and bodies — and the
`SearchResponse` reports which **mode** actually ran, so degradation is visible.
Exposed read-only at `GET /api/search` (`SEARCH_PATH` / `SearchRequest` →
`SearchResponse`), surfaced in a search box that opens a chosen result. Like the
**link graph**, it is a pure-core pipeline (`core/search-index`: chunking,
ranking, and the `Embedder` / `VectorStore` seams) over an injected store +
embedder; unlike it, the vectors are persisted in Postgres. The index is a
**derived projection of git** — never canonical — so it **updates on commit** (a
saved/squashed/created note is re-indexed; a rename/move and every boot rebuild
it) and is **fully rebuildable from the repo** at any time.

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

### External remote

The optional, server-side-configured Git remote (e.g. a GitHub repo) the web
server can track *instead of being an island around its* **bare repo**. By default
none is set and the server uses only its bare repo. When `STOUT_REMOTE_URL` is set,
the server **stays the sync hub** the clients see but additionally pulls-from and
pushes-to that external remote on its sync loop — the server-side counterpart to
the desktop's **hub**. Because *other actors* (a teammate, a laptop `git push`, CI)
can also write to it, its history can **diverge** from the server's `main`, so each
sync performs a **server boundary merge**. Its access credential is a server-side
secret (`STOUT_REMOTE_TOKEN`), never sent to clients, never written to `.git/config`,
never logged in plaintext, materialised into a URL only for a single git op
(reusing the **hub token** credential maths). Clients stay completely unaware it
exists — no client-facing contract changes.

### Server boundary merge

How the server integrates an **external remote**'s divergent history into `main`
**without losing data** — and the reason a plain `git merge` is *not* used. The
policy is the pure `core/remote-sync` (`syncRemoteBoundary` over the narrow
`RemoteBoundaryEngine` seam): fetch the external branch, and for every note that
differs, reconcile its three versions (**base** = merge base, **local** = server
`main`, **incoming** = external tip) with the very same `core/conflict`
**conflict** policy the multi-device story uses — non-overlapping edits
**auto-merge**, a true conflict keeps **both** (incoming on the note, local as a
**conflict copy**), an external-only note is **adopted**, and an external *deletion*
is *not* propagated (keep-both bias). The reconciled tree is written to `main`
first; only then is a bookkeeping merge commit recorded (`git merge -s ours`, which
keeps our tree and merely adds the external tip as a second parent) so the push is a
fast-forward. **Git never merges content** — the conflict policy does; git is just
plumbing to make the push linear. The Node mechanism (`fetch`/`diff`/`show`/the
`-s ours` commit/`push`) is `NodeRemoteBoundaryEngine` in `apps/server`, the
external-remote counterpart to the **git engine**'s `NodeGitEngine`. On the server
(no UI) a resulting **conflict notification** is logged rather than toasted.

### Hub

The remote Git repository the **local-first desktop** clones its **working clone**
from and syncs against — the desktop's counterpart to the web server's **bare
repo**, reachable over HTTPS. It is the shared source of truth several desktop
clients (or a client and the web app) rendezvous on. Reaching it requires a **hub
token**. Configuring a hub is optional: with none set, the desktop runs fully local
(its clone is seeded locally and never synced).

### Hub sync

The desktop's clone-then-sync lifecycle against its **hub**: on first run (no local
clone yet) **clone** the hub; on every subsequent run **pull then push** (integrate
remote work before publishing local). The *policy* — including the credential maths
that injects the **hub token** into the remote URL for a single git op, strips it so
it is never persisted to `.git/config`, and redacts it for logging — is the pure
`core/hub-sync` (`syncWithHub` over the narrow `HubRemoteEngine` seam); the
*mechanism* (shelling `git clone`/`pull`/`push`) is `NodeHubRemoteEngine` in
`apps/server`, the hub-remote counterpart to the **git engine**'s `NodeGitEngine`.
If the hub is unreachable on first run, the desktop falls back to a local-only
workspace so it still opens.

### Hub token

The access credential the desktop authenticates to its **hub** with — a secret. It
is encrypted at rest by the OS keychain (Electron `safeStorage`), **never** logged
and **never** written in plaintext; it is materialised into a remote URL only at the
moment a git op runs, never stored in `.git/config`. The secret-at-rest contract is
the pure `core/token-store` (`TokenStore` over the `SecureStorage` + `SecureFilePorts`
seams; `createSecureFileTokenStore` encrypts before touching disk and refuses to
persist when encryption is unavailable — there is no plaintext fallback). The
Electron adapter (`safe-storage.ts`) backs it with `safeStorage` + a file under the
app's user-data directory.

### Local-first desktop

The Electron app: it runs the **same** built `@stout/ui` SPA and the **same**
`/api/*` surface as the web server (via `@stout/server/desktop`'s
`startLocalWorkspace`), only backed by a local **working clone** on disk and an
**in-memory search index** (the pure hashing embedder + in-memory vector store)
instead of Postgres — so there is **no UI fork** and the window talks only to a
loopback host. It needs no server and, with no **hub** configured, no network.
Having no database is its *healthy* state, not a degraded one. Optionally it syncs
its clone to a **hub** (see **hub sync**) before opening the window.

### Offline PWA

The browser as a **third runtime** for the same `@stout/ui` SPA: an installable,
offline-capable Progressive Web App that owns its **own** local git clone in the
browser. A web app **manifest** plus a **service worker** (Workbox `generateSW`
via `vite-plugin-pwa`, registered once from `main.tsx`) precache the SPA shell and
assets so the app installs and boots with no network; the service worker's
navigation fallback serves the cached shell for app routes but **denylists**
`/api` and `/assets` so live server routes are never shadowed. Its offline note
backend is the **browser git engine** over IndexedDB — the same git-engine seam
the server uses, a filesystem swap, not a forked code path. The running app is
**not** forked to reach it: the whole UI reads and writes through one injectable
`fetch`-shaped **data-source seam**, and the **offline runtime** supplies an
in-browser adapter so the editor, tree, links, search, and autosave loop run
entirely against the browser engine with no server (see **offline runtime**).

### Browser git engine

The IndexedDB-backed implementation of the **git engine**'s write seam
(`WritableGitEngine`) for the **offline PWA** — the browser counterpart to the
server's `NodeGitEngine`. It drives real git (`isomorphic-git`) against a
`@isomorphic-git/lightning-fs` filesystem persisted in IndexedDB, with
**commit-on-save** semantics identical to the server's: list the `.md` files at
`HEAD`, read one note (path-escape-guarded), write + commit an edited note
(skipping no-op writes, so no empty commits), and idempotently init + seed the repo
on first run (`ensureBrowserRepo`, mirroring `ensureWorkspaceRepo`). The pure path
maths (safety guard, joins, ancestor dirs, tracked-file → note-file mapping) is
split out and unit-tested; the engine itself is the thin IO over the two libraries
and runs only in a real browser (it needs IndexedDB), not the offline test suite.

### Sync cadence

The policy for **when** a multi-device sync runs, decided by the pure
`core/sync-cadence` `SyncScheduler` — which owns no DOM and no real timer, running
a single injected sync action on five **triggers**: **launch** (a freshly-opened
tab reconciles immediately), **reconnect** (the network just returned), **focus**
(the tab regained focus / became visible), **timer** (a periodic tick), and
**manual** (a "Sync now" action). Three properties make repeated, overlapping
triggers safe: it is **single-flight** (one sync at a time), **coalescing**
(triggers arriving mid-flight collapse into one follow-up, keeping the stronger
trigger — manual > reconnect > launch > timer > focus), and **throttling** (only
`focus` is rate-limited; the deliberate triggers always run). The browser binding
(`sync-cadence-controller.ts`) is the thin adapter that maps `online` → reconnect,
window focus / visibility → focus, a `setInterval` → timer, construction → launch,
and a manual call → manual, over injectable event targets and clock.

### Conflict

What a multi-device sync does when the same note was edited two ways. Resolution
is the pure three-way (base / local / incoming) reconciliation in `core/conflict`,
over a note's **canonical Markdown** (all three versions canonicalized first, so
formatting-only differences never count). **Non-overlapping** concurrent edits
**auto-merge** (a line-level diff3) into one clean result. A genuine, overlapping
**true conflict** keeps **both** versions with **zero data loss**: the incoming
`main` version stays on the note, and the **local** version is preserved as a
**conflict copy** — a new sibling **leaf note** named from the original plus a UTC
marker (`YYYYMMDD-HHmmss`), its **frontmatter** `title` set to read cleanly, its
identity de-duplicated against existing notes. The decision is expressed as
backing-file writes through the same `WritableGitEngine` seam (`applyConflictResolution`),
so it drives the **browser git engine** identically to any other. A **conflict
notification** then informs the user — never overwrite, always keep-both.

### Conflict notification

The **non-blocking** way the user learns a **conflict copy** was created: a small,
dismissible **toast** in a polite live region (`role="status"`,
`aria-live="polite"`) anchored to a corner — never a modal, never a blocked
editor. Each toast states what happened and offers **"Open copy"** (navigates to
the saved sibling note through the same navigation the **note tree** and wikilinks
use) and **"Dismiss"**. The `core/conflict` policy emits a `ConflictNotification`
per conflict; the workspace owns the toast list and surfaces it over the whole UI
while the editor stays fully interactive behind it.

### Offline runtime

How the **offline PWA** runs the *same* `App` with **no server** and **no UI
fork**. The whole workspace reads and writes through a single injectable
`fetch`-shaped **data-source seam** (default the global `fetch`): the web server
and the **local-first desktop** leave it unset and talk to `/api/*`, while the
offline runtime injects an in-browser adapter (`createBrowserApiFetch`) that
answers the *same* `/api/*` contracts locally by running the *same* `@stout/core`
compositions against the **browser git engine** — note tree, note read/write,
links, keyword search, and the autosave loop (offline is a single writer, so a
**commit-on-save** wip engine commits each autosave straight to `main`). Note
**mutations** and **attachments** are not yet implemented in the browser engine
and return a graceful `501`. A client-side **sync runner** reconciles with a
remote on the **sync cadence**'s triggers and forwards each **conflict
notification** to the toast, degrading to a no-op when there is no remote. The
composition root (`startOfflineApp`) seeds the repo, builds the engine + adapter +
cadence controller, and renders the workspace; one built SPA chooses the runtime
at load from the URL (`?runtime=offline`), which the PWA manifest's `start_url`
requests so the installed app boots offline while the web app at `/` stays on the
server.



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
database reachability, and current migration version. Surfaced in the **contextual
utilities panel**'s System section. On the **local-first desktop** the database is
absent by design, so health reports `ok` with `database: false` — an expected,
healthy state, not a fault.

## Boundaries

- **`@stout/core` is pure** — runtime-agnostic domain logic only, no Node/DOM/git
  imports. The note-tree mapping and the `core/markdown` parser are pure functions
  here; the git engine is an interface here. The Node/git side lives in
  `apps/server`, and the rich editor (TipTap/ProseMirror, DOM-bound) lives behind
  the Editor seam in `packages/ui`.
- **Git is the single source of truth.** Postgres (vector index + derived
  metadata) is disposable and rebuildable from the repo; it is never canonical.
- **One UI, three runtimes.** The web server, the **local-first desktop**, and the
  **offline PWA** all serve the *same* `@stout/ui` build through the *same*
  `core/git-engine` seam; only the backing differs (Postgres + bare repo, a local
  clone + in-memory index, or an IndexedDB clone via the **browser git engine**).
  There is no per-runtime UI fork, and the **hub token** never leaves the OS
  keychain in plaintext.
- **Zero data loss on conflict.** A multi-device **conflict** never overwrites a
  user's words: non-overlapping edits auto-merge, and a true conflict keeps both
  versions (the incoming on the note, the local as a **conflict copy**). The same
  policy reconciles an **external remote**'s divergent history at the **server
  boundary merge**, so integrating outside work is keep-both too — git never merges
  content.
- **The server may track an external remote, invisibly to clients.** The
  source-of-truth repo is configurable: by default the server uses its internal
  **bare repo**; optionally (`STOUT_REMOTE_URL`) it also syncs an **external
  remote** (e.g. GitHub). The remote's credential is a server-side secret and no
  client-facing contract changes — clients neither know nor care.
