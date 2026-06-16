/**
 * Wikilinks and the link graph.
 *
 * Stout notes link to one another by **title**: writing `[[Note Name]]` (or
 * `[[Note Name|alias]]`) in a note's Markdown is a link to whichever note is
 * titled "Note Name". This module is the pure, runtime-agnostic resolver and
 * graph builder behind that feature:
 *
 * - **Title index.** {@link buildTitleIndex} walks the note tree once into a
 *   case-/whitespace-insensitive title → note-`path` index (plus the list of
 *   titles, for `[[` autocomplete).
 * - **Resolution.** {@link resolveWikiLink} turns a parsed {@link WikiLink} into a
 *   {@link ResolvedWikiLink} — the matching note `path`, or `null` when no note
 *   bears that title (a **broken link**).
 * - **Link graph.** {@link buildLinkGraph} extracts every wikilink from a set of
 *   notes' Markdown and resolves it, producing the deduped, sorted set of note→
 *   note {@link LinkEdge edges} and the list of {@link BrokenLink broken links}.
 *
 * Like `core/note-tree`, the mapping is pure; the Node/Git reads that feed it the
 * notes' Markdown live in the engine composition `readLinkGraph` (`core/git-engine`),
 * which the server exposes at `GET /api/links`.
 */

import type { NoteNode } from "./note-tree.js";
import { extractWikiLinks, type WikiLink } from "./markdown.js";

/** REST path of the read-only link-graph endpoint. */
export const LINKS_PATH = "/api/links" as const;

/**
 * A case- and whitespace-insensitive index of note titles → note identities,
 * built once from the tree and reused to resolve every wikilink.
 */
export interface TitleIndex {
  /**
   * Normalized title (see {@link normalizeTitle}) → note `path`s sharing it, in
   * tree order. Most titles map to a single note; an array captures the rare
   * ambiguous case (resolution then deterministically takes the first).
   */
  byTitle: Map<string, string[]>;
  /** Every note's display title in tree order — the source for `[[` autocomplete. */
  titles: string[];
}

/** A resolved wikilink: the parsed link plus the note it points at (if any). */
export interface ResolvedWikiLink {
  /** The note title the link targets, as written. */
  target: string;
  /** The display alias, if the link was written `[[target|alias]]`. */
  alias?: string;
  /** Identity (tree `path`) of the matching note, or `null` when broken. */
  path: string | null;
  /** Whether the link resolves to no note (`path === null`). */
  broken: boolean;
}

/** A single note's content, the input unit of {@link buildLinkGraph}. */
export interface NoteContent {
  /** Identity (tree `path`) of the note (the root note is `""`). */
  path: string;
  /** The note's display title. */
  title: string;
  /** The note's Markdown content (scanned for `[[wikilinks]]`). */
  markdown: string;
}

/** A resolved link from one note to another in the {@link LinkGraph}. */
export interface LinkEdge {
  /** Identity of the note containing the link. */
  from: string;
  /** Identity of the note the link resolves to. */
  to: string;
}

/** A wikilink whose target title matches no note. */
export interface BrokenLink {
  /** Identity of the note containing the broken link. */
  from: string;
  /** The unresolved target title, as written. */
  target: string;
}

/**
 * The note link graph: resolved note→note {@link LinkEdge edges} and the
 * {@link BrokenLink broken links} whose targets match no note. Both lists are
 * deduplicated and sorted, so the graph is a deterministic function of the notes.
 */
export interface LinkGraph {
  /** Resolved links between notes (deduped, sorted by `from` then `to`). */
  edges: LinkEdge[];
  /** Links pointing at a non-existent title (deduped, sorted by `from` then `target`). */
  broken: BrokenLink[];
}

/** Response body of `GET /api/links` — the whole {@link LinkGraph}. */
export type LinkGraphResponse = LinkGraph;

/**
 * Normalize a note title for matching: trim, lowercase, and collapse internal
 * whitespace runs to single spaces. So `[[ Note   Name ]]` links to a note titled
 * "Note Name" — links resolve by title, case- and spacing-insensitively.
 */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * Walk the note tree into a {@link TitleIndex}. Pure and deterministic: visits
 * the tree in depth-first order, so `titles` is stable and the first note to
 * claim a title wins resolution ties.
 */
export function buildTitleIndex(root: NoteNode): TitleIndex {
  const byTitle = new Map<string, string[]>();
  const titles: string[] = [];

  const visit = (node: NoteNode): void => {
    titles.push(node.title);
    const key = normalizeTitle(node.title);
    const paths = byTitle.get(key);
    if (paths) paths.push(node.path);
    else byTitle.set(key, [node.path]);
    for (const child of node.children) visit(child);
  };
  visit(root);

  return { byTitle, titles };
}

/**
 * Resolve a note title to its identity (tree `path`) via the index, or `null`
 * when no note bears that title. On the rare ambiguous title, the first note in
 * tree order wins (deterministic).
 */
export function resolveTitle(index: TitleIndex, title: string): string | null {
  const paths = index.byTitle.get(normalizeTitle(title));
  return paths && paths.length > 0 ? paths[0] : null;
}

/**
 * Resolve a parsed {@link WikiLink} against the {@link TitleIndex}. The result
 * carries the matching note `path` (or `null`) and the `broken` flag the UI uses
 * to surface dangling links.
 */
export function resolveWikiLink(index: TitleIndex, link: WikiLink): ResolvedWikiLink {
  const path = resolveTitle(index, link.target);
  return {
    target: link.target,
    ...(link.alias !== undefined ? { alias: link.alias } : {}),
    path,
    broken: path === null,
  };
}

/**
 * Build the {@link LinkGraph} from a set of notes and a {@link TitleIndex}.
 *
 * Pure: extracts every `[[wikilink]]` from each note's Markdown, resolves it, and
 * collects note→note edges for the resolved ones and {@link BrokenLink}s for the
 * rest. Self-links (a note linking to itself) are ignored. Edges and broken links
 * are deduplicated and sorted, so the same notes always yield byte-identical
 * output.
 */
export function buildLinkGraph(notes: NoteContent[], index: TitleIndex): LinkGraph {
  const edgeKeys = new Set<string>();
  const edges: LinkEdge[] = [];
  const brokenKeys = new Set<string>();
  const broken: BrokenLink[] = [];

  for (const note of notes) {
    for (const link of extractWikiLinks(note.markdown)) {
      const resolved = resolveWikiLink(index, link);
      if (resolved.path === null) {
        const key = `${note.path}\u0000${normalizeTitle(link.target)}`;
        if (!brokenKeys.has(key)) {
          brokenKeys.add(key);
          broken.push({ from: note.path, target: link.target });
        }
        continue;
      }
      // Ignore a note linking to itself; it adds no navigational structure.
      if (resolved.path === note.path) continue;
      const key = `${note.path}\u0000${resolved.path}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        edges.push({ from: note.path, to: resolved.path });
      }
    }
  }

  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  broken.sort(
    (a, b) => a.from.localeCompare(b.from) || a.target.localeCompare(b.target),
  );
  return { edges, broken };
}
