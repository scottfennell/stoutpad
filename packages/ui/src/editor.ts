/**
 * The Editor seam.
 *
 * Stout's center panel renders a note through a swappable **Editor**: a React
 * component with a "Markdown in, change events out" contract ({@link EditorProps}).
 * The default implementation is {@link TipTapEditor}, but any component honoring
 * the contract can be dropped in (e.g. a plain textarea in tests). See
 * `docs/adr/0002-editor-seam-and-tiptap.md`.
 *
 * This module also holds the pure bridge between Stout's canonical Markdown and
 * TipTap/ProseMirror's document JSON. The Markdown grammar is parsed by the pure
 * `core/markdown`; here we only map its {@link MarkdownDocument} model to/from the
 * editor's node tree, so the editor stays a thin rendering shell over the seam.
 */

import type { JSONContent } from "@tiptap/core";
import {
  parseInline,
  parseMarkdown,
  parseWikiLink,
  type InlineMark,
  type MarkdownBlock,
  type MarkdownSpan,
  type WikiLink,
} from "@stout/core";
import type { ReactElement } from "react";

/**
 * The wikilink context the editor renders against: how to resolve a `[[link]]`
 * target to a note, the titles available for `[[` autocomplete, and where to
 * navigate when a resolved link is clicked. Supplied by `App` from the loaded
 * note tree; the editor stays agnostic of how resolution works.
 */
export interface WikiLinkContext {
  /** Every note title, for `[[` autocomplete suggestions. */
  titles: string[];
  /** Resolve a link target (a note title) to its note `path`, or `null` if broken. */
  resolve: (target: string) => string | null;
  /** Navigate to a resolved note (its `path`) when its link is clicked. */
  onNavigate?: (path: string, target: string) => void;
}

/** "Markdown in, change events out" — the contract every Editor honors. */
export interface EditorProps {
  /** Canonical Markdown content of the note to render. */
  markdown: string;
  /** Called with the updated Markdown whenever the user edits. */
  onChange?: (markdown: string) => void;
  /** Whether the note is editable (default `true`). */
  editable?: boolean;
  /**
   * Wikilink rendering/navigation/autocomplete context. When omitted, `[[links]]`
   * render as plain literal text (no styling, navigation, or autocomplete).
   */
  wikiLinks?: WikiLinkContext;
}

/** A swappable Editor: a React component honoring {@link EditorProps}. */
export type EditorComponent = (props: EditorProps) => ReactElement | null;

/** Stout inline mark → ProseMirror/TipTap mark name. */
const MARK_NAME: Record<InlineMark, string> = {
  bold: "bold",
  italic: "italic",
  code: "code",
};

function spanToTextNode(span: MarkdownSpan): JSONContent | null {
  // ProseMirror forbids empty text nodes; drop them.
  if (span.text.length === 0) return null;
  const node: JSONContent = { type: "text", text: span.text };
  if (span.marks.length > 0) {
    node.marks = span.marks.map((mark) => ({ type: MARK_NAME[mark] }));
  }
  return node;
}

function inlineToNodes(text: string): JSONContent[] {
  return parseInline(text)
    .map(spanToTextNode)
    .filter((node): node is JSONContent => node !== null);
}

function withContent(node: JSONContent, content: JSONContent[]): JSONContent {
  return content.length > 0 ? { ...node, content } : node;
}

function paragraphNode(text: string): JSONContent {
  return withContent({ type: "paragraph" }, inlineToNodes(text));
}

function blockToNode(block: MarkdownBlock): JSONContent {
  switch (block.type) {
    case "heading":
      return withContent(
        { type: "heading", attrs: { level: block.level } },
        inlineToNodes(block.text),
      );
    case "paragraph":
      return paragraphNode(block.text);
    case "bulletList":
      return {
        type: "bulletList",
        content: block.items.map((item) => ({
          type: "listItem",
          content: [paragraphNode(item)],
        })),
      };
    case "taskList":
      return {
        type: "taskList",
        content: block.items.map((item) => ({
          type: "taskItem",
          attrs: { checked: item.checked },
          content: [paragraphNode(item.text)],
        })),
      };
  }
}

/** Parse canonical Markdown into a TipTap/ProseMirror `doc` JSON node. */
export function markdownToTipTapDoc(markdown: string): JSONContent {
  const blocks = parseMarkdown(markdown).blocks.map(blockToNode);
  return {
    type: "doc",
    content: blocks.length > 0 ? blocks : [{ type: "paragraph" }],
  };
}

function textNodeToMarkdown(node: JSONContent): string {
  const text = node.text ?? "";
  const marks = new Set((node.marks ?? []).map((mark) => mark.type));
  if (marks.has("code")) return `\`${text}\``;
  if (marks.has("bold")) return `**${text}**`;
  if (marks.has("italic")) return `*${text}*`;
  return text;
}

function inlineText(content: JSONContent[] | undefined): string {
  return (content ?? [])
    .map((node) =>
      node.type === "text" ? textNodeToMarkdown(node) : inlineText(node.content),
    )
    .join("");
}

function firstParagraphText(item: JSONContent): string {
  const paragraph = (item.content ?? []).find((n) => n.type === "paragraph");
  return inlineText(paragraph?.content);
}

function nodeToMarkdown(node: JSONContent): string | null {
  switch (node.type) {
    case "heading": {
      const level = typeof node.attrs?.level === "number" ? node.attrs.level : 1;
      return `${"#".repeat(level)} ${inlineText(node.content)}`;
    }
    case "paragraph":
      return inlineText(node.content);
    case "bulletList":
      return (node.content ?? [])
        .map((item) => `- ${firstParagraphText(item)}`)
        .join("\n");
    case "taskList":
      return (node.content ?? [])
        .map(
          (item) =>
            `- [${item.attrs?.checked ? "x" : " "}] ${firstParagraphText(item)}`,
        )
        .join("\n");
    default:
      return null;
  }
}

/** Serialize a TipTap/ProseMirror `doc` JSON node back to canonical Markdown. */
export function tipTapDocToMarkdown(doc: JSONContent): string {
  const blocks = (doc.content ?? [])
    .map(nodeToMarkdown)
    .filter((block): block is string => block !== null);
  return `${blocks.join("\n\n").trim()}\n`;
}

/** A `[[wikilink]]` found in a run of text, with its character offsets. */
export interface WikiLinkMatch {
  /** Offset of the opening `[[` in the scanned text. */
  start: number;
  /** Offset just past the closing `]]`. */
  end: number;
  /** The parsed link. */
  link: WikiLink;
}

// Mirrors `core`'s wikilink pattern; the global flag is for position scanning.
const WIKILINK_SCAN = /\[\[([^\]\n]+?)\]\]/gu;

/**
 * Find every `[[wikilink]]` in a run of text, with offsets — the input the editor
 * decoration uses to underline links in place. Pure; skips empty-target `[[ ]]`.
 */
export function scanWikiLinks(text: string): WikiLinkMatch[] {
  const matches: WikiLinkMatch[] = [];
  for (const m of text.matchAll(WIKILINK_SCAN)) {
    const link = parseWikiLink(m[1]);
    if (link && m.index !== undefined) {
      matches.push({ start: m.index, end: m.index + m[0].length, link });
    }
  }
  return matches;
}

/**
 * Extract the in-progress `[[` autocomplete query from the text *before* the
 * cursor, or `null` when the cursor is not inside an open, un-aliased wikilink.
 *
 * Returns the text typed after the nearest unclosed `[[` (e.g. `"Pro"` for
 * `"see [[Pro"`). Bails once the link is closed (`]]`), a pipe starts an alias
 * (`|`), a new bracket appears, or a newline intervenes — pure string logic, so
 * it is unit-tested without a live editor.
 */
export function wikiLinkQuery(textBefore: string): string | null {
  const open = textBefore.lastIndexOf("[[");
  if (open === -1) return null;
  const after = textBefore.slice(open + 2);
  if (/[[\]\n|]/u.test(after)) return null;
  return after;
}

/**
 * Rank note titles for a `[[` autocomplete `query`: case-insensitive substring
 * matches, earliest match first, ties broken alphabetically, deduped, capped at
 * `limit`. An empty query returns the first `limit` titles. Pure and testable.
 */
export function filterTitles(titles: string[], query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const ranked: Array<{ title: string; rank: number }> = [];
  for (const title of titles) {
    const lower = title.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const at = q === "" ? 0 : lower.indexOf(q);
    if (at === -1) continue;
    ranked.push({ title, rank: at });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title));
  return ranked.slice(0, limit).map((m) => m.title);
}
