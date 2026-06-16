# 6. Wikilinks and the link graph

- Status: Accepted
- Date: 2026-06-15
- Issue: #8 (Wikilinks + link graph)

## Context

Notes so far are islands: the note tree (ADR 0001) gives them a *containment*
hierarchy, but there is no way for one note to *reference* another. Users expect
wiki-style inter-linking — write `[[Note Name]]` in a note and have it become a
link to whichever note bears that title, with `[[` autocomplete, click-to-
navigate, and broken links (targets that match no note) visibly flagged.

This crosses every layer, so several things need deciding:

1. **Link identity: title or path?** A `[[wikilink]]` could target a note's
   `path` identity (stable, but ugly to type) or its **title** (what users
   actually know). The issue calls for "resolve by title", which also means
   resolution is *ambient* — it depends on the whole tree, and a link can break
   or re-resolve as notes are renamed/moved.
2. **Where resolution lives.** Parsing `[[…]]` out of Markdown is pure string
   work that belongs with the rest of the grammar in `core/markdown`. But
   *resolving* a target against the set of note titles, and building a whole-repo
   **link graph**, is a different concern that needs the tree, not just one note's
   text.
3. **How the editor renders links** without corrupting the canonical Markdown.
   The literal `[[Note Name]]` must survive round-tripping (ADR 0003) — styling a
   link cannot rewrite the bytes.
4. **Where link resolution happens for the UI** — server-side (a `/api/links`
   fetch) or client-side off the already-loaded tree?

## Decision

### Links resolve by title, case- and whitespace-insensitively

- A `[[Target]]` (or `[[Target|Alias]]`) resolves to the note whose **title**
  matches `Target`. Matching is normalized (`normalizeTitle`: trim, collapse
  internal whitespace, lowercase), so `[[ note   name ]]` finds "Note Name".
- Resolution is a function of the **whole note tree**, not of any one note. The
  rare ambiguous title (two notes sharing one) resolves deterministically to the
  first in depth-first tree order; this is a known, documented tie-break, not an
  error.
- A target matching no note is a **broken link** — a first-class, surfaced state,
  not a failure. Because resolution is ambient, the same link is "broken" or not
  depending on the current tree; renaming a note can make or break links to it.

### Parse in `core/markdown`, resolve in a new pure `core/wikilink`

The issue frames this as "`core/markdown` resolves wikilinks", but parsing and
resolution are genuinely different concerns, so they split across two pure
modules:

- **`core/markdown` parses the syntax.** A `[[wikilink]]` is added to the inline
  grammar: it is matched first and atomically (so its inner text is never re-read
  as bold/italic/code), producing a `MarkdownSpan` whose `text` stays the
  **literal** `[[…]]` (so it serializes back unchanged) plus a parsed `link`
  (`WikiLink { target, alias? }`). `parseWikiLink` (one link's inner text) and
  `extractWikiLinks` (every link in a note, in document order) are the parsing
  primitives.
- **`core/wikilink` resolves against the tree.** `buildTitleIndex` walks the tree
  once into a normalized title→`path` index (plus the title list for
  autocomplete); `resolveTitle` / `resolveWikiLink` turn a target into a note
  `path` or `null`; `buildLinkGraph` extracts and resolves every link across a set
  of notes into a deduped, sorted `LinkGraph` of note→note `edges` and
  `broken` links (self-links ignored). All pure, mirroring how `core/note-tree`
  maps files→tree — the Node/git reads that feed it live in the `readLinkGraph`
  engine composition (`core/git-engine`).

Keeping resolution out of `core/markdown` means the Markdown parser stays a
single-note, tree-agnostic function; the tree-aware reasoning lives in one place.

### A read-only link-graph endpoint, but a client-side resolver for the editor

- The server exposes `GET /api/links` (`LINKS_PATH` → `LinkGraphResponse`), wired
  to `readLinkGraph(NodeGitEngine)`: it reads every note's Markdown and returns
  the whole graph. This is the queryable, whole-repo view (the future basis for
  backlinks / graph navigation).
- **The editor, though, resolves links client-side off the already-loaded note
  tree** — it does *not* fetch `/api/links`. `App` builds a `TitleIndex` from the
  tree it already has and hands the editor a `WikiLinkContext` (the `titles` for
  autocomplete, a `resolve(target) → path | null`, and an `onNavigate(path)`
  callback). Resolution is local, synchronous, and always consistent with the
  tree the user sees; no extra round-trip, and broken state updates the instant
  the tree reloads after a mutation.

### Rendering via a ProseMirror decoration, never a schema change

- The TipTap editor paints links with a **decoration plugin**
  (`wikilink-decoration`), not a custom node/mark. It scans each text node for
  `[[links]]` (`scanWikiLinks`), resolves each through the injected resolver, and
  adds an inline decoration carrying a CSS class (`wikilink`, or
  `wikilink wikilink-broken` for a dangling target) plus `data-wikilink-target` /
  `data-wikilink-path` attributes. The literal `[[…]]` text is **untouched**, so
  Markdown still round-trips byte-for-byte (ADR 0003) — only appearance and data
  attributes are layered on. The resolver is read fresh on every rebuild, and
  `refreshWikiLinkDecorations` forces a rebuild when the tree (resolver) changes
  without the document changing.
- **Broken links are visually surfaced** by the `wikilink-broken` class (dashed,
  red), distinct from a resolved link (solid underline).
- **Navigation** is event-delegated at the editor container: a click whose target
  sits inside `[data-wikilink-path]` calls `onNavigate(path)`, which selects that
  note. A broken link carries no `data-wikilink-path`, so it is inert.
- **Autocomplete**: typing `[[` opens a suggestion popup. The in-progress query is
  extracted purely (`wikiLinkQuery` reads the text before the caret), ranked
  against the titles purely (`filterTitles`: case-insensitive substring, earliest
  match first, alphabetical tie-break, capped), and the popup is driven through
  ProseMirror's `handleKeyDown` (arrows/enter/escape) so it never fights the
  editor. Picking a title inserts `[[Title]]`.

## Consequences

- **Resolution + broken-link detection are unit-tested purely, offline.** The
  `core/wikilink` index/resolver/graph and the `core/markdown` link parser are
  tested as pure functions (title normalization, ambiguous-title tie-break,
  edge/broken-link dedup + sort, self-link exclusion), satisfying the
  "unit-tested" acceptance criterion without an editor or a live repo. The pure
  editor helpers (`wikiLinkQuery` / `filterTitles` / `scanWikiLinks`) are tested
  the same way; the decoration rendering, click-navigation, and suggestion popup
  get lighter component tests.
- **Links are title-coupled, which is an opinion.** Because a link targets a
  title, renaming a note silently breaks inbound links (and a different note
  taking the old title silently captures them). This matches wiki convention and
  keeps Markdown human-writable, but it means rename is *not* link-preserving —
  link-rewrite-on-rename is a deliberate later slice, not part of this one. The
  broken-link surfacing is what makes this safe to ship.
- **Two resolution paths, one source of truth.** The editor resolves client-side
  while `/api/links` resolves server-side; both derive from the same tree +
  `core/wikilink` logic, so they agree by construction. The endpoint exists for
  whole-repo queries the editor does not need.
- **The link graph is a pure, deterministic artifact.** `buildLinkGraph` sorts and
  dedupes, so the same notes always produce byte-identical output — a stable basis
  for the future backlinks panel / graph view, and cheap to diff or cache.
- **Markdown stays canonical.** Rendering is purely decorative (decorations +
  data attributes), so no wikilink feature can perturb the saved bytes; the
  round-trip and idempotence guarantees of ADR 0003 are untouched.
