# 9. Workspace layout & Technical Umber styling

- Status: Accepted
- Date: 2026-06-16
- Issue: #11 (Workspace layout & Technical Umber styling)

## Context

The prior slices (ADR 0001–0008) built a fully functional but largely unstyled
UI: a tree, an editor, search, mutations, and contextual data (frontmatter,
links, health) all work, but the workspace has no deliberate visual language and
no responsive story. `DESIGN.md` defines **Technical Umber** — a dark, warm,
"technical document" aesthetic with a fixed palette, a three-family type system
(Geist / Hanken Grotesk / JetBrains Mono), a soft-radius scale, and a 4px spacing
grid. This slice makes the workspace *look like the product*: a three-panel
desktop layout, a focused single-column mobile layout, and the Technical Umber
tokens applied throughout.

Several forces shape the design:

- **Identical UI behaviour across runtimes (a hard acceptance criterion).** The
  browser SPA and the Electron shell load the **same** UI build; there must be no
  per-runtime layout fork. Responsiveness therefore has to be **pure CSS**
  (media/container queries), not JavaScript that branches on the host.
- **Tests stay green and run unstyled (ADR 0002, 0004–0008).** The existing 42 UI
  tests assert on roles, accessible names, test-ids, and text — never on computed
  style. Styling must not change that contract: every existing test hook is
  preserved, and the stylesheet is loaded **only by the app entry** so jsdom tests
  render structure without CSS.
- **No network at runtime.** Stout is local-first; the UI must never fetch a font
  (or anything else) from a third party at runtime. Fonts are referenced by name
  with a graceful system fallback.
- **Reuse the data already loaded.** The right utilities panel must show **real**
  context for the open note — not placeholder text — and it should not invent new
  network traffic where the data is already in hand (the tree, the note body, the
  link graph).
- **A human gate.** The issue carries an explicit **HITL design review**: an agent
  can implement to the spec and keep the tests green, but signing off that the
  result *matches the visual language* is a human judgement.

## Decision

### A three-panel workspace that collapses to one focused column

`App` renders a `.workspace` grid of three always-present panels:

- **Left — navigation** (`<aside aria-label="Navigation">`, `data-testid="nav-panel"`):
  the brand lockup, a "New Note" CTA, the search box, and the note tree with its
  per-node create/rename/move affordances.
- **Center — editor** (`<main aria-label="Editor">`, `data-testid="editor-panel"`):
  the selected note's header (kind eyebrow + title + tag chips), the attachment
  control, and the editor over the frontmatter-free body. The focus surface, so it
  takes the most recessed background.
- **Right — contextual utilities** (`<aside aria-label="Note context">`,
  `data-testid="utility-panel"`): everything about the **selected** note, built
  entirely from data already loaded — **Details** (its tree node: identity /
  backing file / kind), **Outline** (its heading table-of-contents, parsed from
  the note body), **Links** (its backlinks / outbound / broken, sliced from the
  **link graph**), and **System** (walking-skeleton health). Empty until a note is
  open; link rows reuse the same navigation as the tree, search, and wikilinks.

The whole thing is **responsive in pure CSS**. Above 1024px it is the three-column
grid; below, `.workspace` becomes a single column and a bottom **mobile tab
switcher** (`role="tab"` × {Navigation, Editor, Context}) chooses which panel is
visible, driven by a `data-mobile-pane` attribute on the shell. Selecting a note
(from the tree, a search hit, a wikilink, or a backlink) also switches the mobile
pane to the editor, so opening a note brings it into view on a phone. There is no
runtime branch anywhere — the browser and Electron render byte-identically.

### One global stylesheet of Technical Umber tokens, loaded only at the app entry

`packages/ui/src/styles.css` turns the `DESIGN.md` palette, typography, radii, and
spacing into CSS custom properties on `:root` and applies them. It is imported
**once from `main.tsx`** (the app entry), never from `App.tsx`. Consequence: the
shipped app is fully themed, while the component unit tests (which render `App`
directly) run **unstyled** — so they keep asserting on structure, not pixels, and
the styling carries zero test risk. `index.html` declares `color-scheme: dark`
and a matching `theme-color` so the document chrome is dark from first paint.

### Font strategy: named-first, system fallback, no runtime fetch

The three families are referenced **by name first**, then degrade through a system
stack (`Geist → system-ui/-apple-system/…`, `Hanken Grotesk → system-ui/…`,
`JetBrains Mono → ui-monospace/…`). If the families are installed (or self-hosted
later by dropping `@font-face` files into the stylesheet) they are used; otherwise
the platform UI + monospace fonts stand in. Either way the app **never requires
the network at runtime**. Self-hosting the web-font files is an explicitly
deferred, additive follow-up — not a prerequisite for this slice.

### Test hooks preserved; layout coverage added

Every existing role, accessible name, and `data-testid` is kept (health moved into
the utilities panel keeps `status`/`database`/`migration`; the tree, search,
mutations, frontmatter, attachments, and wikilink hooks are unchanged), so the 42
prior tests pass without edits. Two new test groups assert the **structure** the
styling depends on: the three named landmark panels + the three mobile tabs exist,
and the utilities panel renders a selected note's details, heading outline, and
backlinks/outbound/broken links and navigates on click. The wikilink decoration
colours are re-pointed to the palette (tertiary blue for resolved, error red for
broken); no test asserts on colour, so this is safe.

## Consequences

- **Identical across runtimes (criterion met).** Layout is pure responsive CSS
  with no host branch, so the browser SPA and the Electron shell present the same
  three-panel/one-column workspace.
- **Three-panel desktop + single-column mobile (criteria met).** The grid and the
  `@media (max-width: 1023px)` collapse + tab switcher deliver both layouts from
  one stylesheet; a layout-structure test pins the panels and tabs in place.
- **Technical Umber applied (criterion met, pending sign-off).** The palette,
  type families, radii, and spacing from `DESIGN.md` are tokenised and applied.
  Whether the result *faithfully matches the design language* is the remaining
  **human design review** — the one acceptance criterion an agent cannot close.
- **Styling is test-safe.** Because the stylesheet loads only at the app entry,
  unit tests render unstyled and keep asserting on structure; the new tests lock
  in the DOM contract the CSS targets, so a future restyle can't silently drop a
  panel.
- **The utilities panel is real, not lorem.** It is composed from data already in
  the client (tree, note body, link graph, health), so it adds **no** new network
  traffic beyond the existing `GET /api/links` (which already degrades gracefully
  to an empty graph if absent), and it always reflects the actually-open note.
- **Fonts degrade gracefully.** With the named families absent, the system stack
  renders a faithful-enough approximation and nothing is fetched; installing or
  self-hosting the families later upgrades the type with no code change.
