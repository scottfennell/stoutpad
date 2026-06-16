/**
 * Pure Markdown parsing helpers.
 *
 * `core/markdown` is the runtime-agnostic seam that turns a note's canonical
 * Markdown content into a small, structured document model. It is pure: no Node,
 * no DOM, no Markdown library — just string in, model out. The rich/`live`
 * rendering (and serialization back to Markdown) is the {@link EditorComponent}'s
 * job in `@stout/ui`; this module is what the editor (and tests) parse against.
 *
 * Scope for this slice (see `docs/adr/0002-editor-seam-and-tiptap.md`): the block
 * grammar Stout's editor renders today — headings, paragraphs, bullet lists, and
 * GFM-style task lists (checkboxes) — plus a minimal inline grammar (`**bold**`,
 * `*italic*`, `` `code` ``, and `[[wikilinks]]`). Nested lists are flattened to a
 * single level and other constructs degrade to paragraphs; richer grammar lands
 * in later slices.
 */

/** A heading level, `#` (1) through `######` (6). */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** An inline formatting mark applied to a run of text. */
export type InlineMark = "bold" | "italic" | "code";

/**
 * A `[[wikilink]]` to another note by its **title** (see `core/wikilink`).
 *
 * Written `[[Target]]` or `[[Target|Alias]]`: `target` is the note title to
 * resolve, `alias` (when present) is the text to display instead. The link is
 * resolved to a note `path` by `core/wikilink`; this module only parses the
 * syntax out of the Markdown.
 */
export interface WikiLink {
  /** The note title this link points at (`[[target]]`). */
  target: string;
  /** Display text override, if the link was written `[[target|alias]]`. */
  alias?: string;
}

/** A run of inline text with zero or more formatting marks. */
export interface MarkdownSpan {
  /** The literal text of the run (delimiters already stripped). */
  text: string;
  /** Formatting marks applied to this run. */
  marks: InlineMark[];
  /**
   * Set when this span is a `[[wikilink]]`. The span's `text` stays the **literal**
   * `[[…]]` source (so it round-trips through serialization unchanged); `link`
   * carries the parsed target/alias for the editor to render and resolve.
   */
  link?: WikiLink;
}

/** A single checkbox item in a task list. */
export interface TaskItem {
  /** Whether the box is ticked (`[x]`) or empty (`[ ]`). */
  checked: boolean;
  /** Raw inline Markdown of the item (parse with {@link parseInline}). */
  text: string;
}

/** A top-level block in a parsed note. */
export type MarkdownBlock =
  | { type: "heading"; level: HeadingLevel; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bulletList"; items: string[] }
  | { type: "taskList"; items: TaskItem[] };

/** A parsed note: an ordered list of top-level blocks. */
export interface MarkdownDocument {
  blocks: MarkdownBlock[];
}

const HEADING = /^(#{1,6})\s+(.*)$/u;
const TASK_ITEM = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/u;
const BULLET_ITEM = /^\s*[-*+]\s+(.*)$/u;

/**
 * Parse a note's Markdown into the {@link MarkdownDocument} block model.
 *
 * Pure and deterministic. Inline content of each block is kept as raw Markdown;
 * call {@link parseInline} to resolve it into formatted spans.
 */
export function parseMarkdown(markdown: string): MarkdownDocument {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];

  let paragraph: string[] = [];
  let listKind: "task" | "bullet" | null = null;
  let taskItems: TaskItem[] = [];
  let bulletItems: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", text: paragraph.join(" ").trim() });
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (listKind === "task" && taskItems.length > 0) {
      blocks.push({ type: "taskList", items: taskItems });
      taskItems = [];
    } else if (listKind === "bullet" && bulletItems.length > 0) {
      blocks.push({ type: "bulletList", items: bulletItems });
      bulletItems = [];
    }
    listKind = null;
  };
  const flush = (): void => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    if (line.trim() === "") {
      flush();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({
        type: "heading",
        level: heading[1].length as HeadingLevel,
        text: heading[2].trim(),
      });
      continue;
    }

    const task = TASK_ITEM.exec(line);
    if (task) {
      flushParagraph();
      if (listKind === "bullet") flushList();
      listKind = "task";
      taskItems.push({ checked: task[1].toLowerCase() === "x", text: task[2].trim() });
      continue;
    }

    const bullet = BULLET_ITEM.exec(line);
    if (bullet) {
      flushParagraph();
      if (listKind === "task") flushList();
      listKind = "bullet";
      bulletItems.push(bullet[1].trim());
      continue;
    }

    // Anything else is paragraph prose; a list cannot continue through it.
    flushList();
    paragraph.push(line.trim());
  }

  flush();
  return { blocks };
}

// A `[[wikilink]]` is matched first and atomically, so its inner text is never
// re-interpreted as bold/italic/code. Group map: 1 `[[`, 2 link inner, 3 code
// fence (backref `\3`), 4 code text, 5 `**`, 6 bold text, 7 `*`, 8 italic text.
const INLINE =
  /(\[\[)([^\]\n]+?)\]\]|(`+)([^`]+?)\3|(\*\*)([^*]+?)\*\*|(\*)([^*]+?)\*/su;

/** Pattern matching a single `[[wikilink]]`; group 1 is the inner `target|alias`. */
const WIKILINK = /\[\[([^\]\n]+?)\]\]/gu;

/**
 * Parse the inner text of a `[[wikilink]]` (`target` or `target|alias`) into a
 * {@link WikiLink}, or `null` when the target is empty (so `[[ ]]` is not a link).
 * Pure: the syntax only — resolution to a note `path` lives in `core/wikilink`.
 */
export function parseWikiLink(inner: string): WikiLink | null {
  const pipe = inner.indexOf("|");
  const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  if (target === "") return null;
  const alias = pipe === -1 ? "" : inner.slice(pipe + 1).trim();
  return alias ? { target, alias } : { target };
}

/**
 * Extract every `[[wikilink]]` from a note's Markdown, in document order.
 *
 * Pure and global: scans the whole string (across blocks), skipping empty-target
 * `[[ ]]`. This is the link-graph's parsing primitive — `core/wikilink` resolves
 * each {@link WikiLink} to a note and detects broken links from the result.
 */
export function extractWikiLinks(markdown: string): WikiLink[] {
  const links: WikiLink[] = [];
  for (const match of markdown.matchAll(WIKILINK)) {
    const link = parseWikiLink(match[1]);
    if (link) links.push(link);
  }
  return links;
}

/**
 * Resolve a run of inline Markdown into formatted {@link MarkdownSpan spans}.
 *
 * Supports `**bold**`, `*italic*`, `` `code` ``, and `[[wikilinks]]`; marks are
 * not nested or combined. A wikilink span keeps the literal `[[…]]` as its `text`
 * (so it serializes back unchanged) and carries the parsed {@link WikiLink} in
 * `link`. Always returns at least one span (possibly empty) so callers can map
 * directly to editor text nodes.
 */
export function parseInline(text: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let plain = "";
  let rest = text;

  const pushPlain = (): void => {
    if (plain.length > 0) {
      spans.push({ text: plain, marks: [] });
      plain = "";
    }
  };

  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (!match) {
      plain += rest;
      break;
    }
    plain += rest.slice(0, match.index);
    if (match[1] !== undefined) {
      const link = parseWikiLink(match[2]);
      if (link) {
        pushPlain();
        // Keep the literal `[[…]]` so it round-trips; carry the parsed link.
        spans.push({ text: match[0], marks: [], link });
      } else {
        // Empty-target `[[ ]]` isn't a link; treat it as plain text.
        plain += match[0];
      }
    } else if (match[3] !== undefined) {
      pushPlain();
      spans.push({ text: match[4], marks: ["code"] });
    } else if (match[5] !== undefined) {
      pushPlain();
      spans.push({ text: match[6], marks: ["bold"] });
    } else {
      pushPlain();
      spans.push({ text: match[8], marks: ["italic"] });
    }
    rest = rest.slice(match.index + match[0].length);
  }
  pushPlain();

  if (spans.length === 0) spans.push({ text: "", marks: [] });
  return spans;
}

/** Flatten formatted spans back to their plain text (drops marks). */
export function spansToPlainText(spans: MarkdownSpan[]): string {
  return spans.map((span) => span.text).join("");
}

/** Serialize a single block to its one-or-more canonical Markdown lines. */
function serializeBlock(block: MarkdownBlock): string {
  switch (block.type) {
    case "heading":
      return `${"#".repeat(block.level)} ${block.text}`;
    case "paragraph":
      return block.text;
    case "bulletList":
      return block.items.map((item) => `- ${item}`).join("\n");
    case "taskList":
      return block.items
        .map((item) => `- [${item.checked ? "x" : " "}] ${item.text}`)
        .join("\n");
  }
}

/**
 * Serialize a parsed note back to **canonical** CommonMark + GFM.
 *
 * This is the inverse of {@link parseMarkdown} and the heart of "Markdown is the
 * canonical representation": the same logical content always yields byte-identical
 * Markdown, so saving an edit produces a stable, diff-friendly file. The output is:
 *
 * - ATX headings (`#`…`######` + a single space),
 * - one blank line between blocks,
 * - `-` bullet markers, `- [x]`/`- [ ]` GFM task markers,
 * - a single trailing newline (and the empty string for an empty note).
 *
 * It is **deterministic** (no ambient state) and **idempotent**: feeding the
 * result back through {@link parseMarkdown} and serializing again is byte-stable
 * (`serialize(parse(serialize(x))) === serialize(x)`). Inline content is emitted
 * verbatim, so callers should pass the block model produced by
 * {@link parseMarkdown} (whose block text is already single-line and normalized).
 */
export function serializeMarkdown(
  input: MarkdownDocument | MarkdownBlock[],
): string {
  const blocks = Array.isArray(input) ? input : input.blocks;
  const body = blocks.map(serializeBlock).join("\n\n").trim();
  return body.length > 0 ? `${body}\n` : "";
}

/**
 * Canonicalize arbitrary Markdown: parse it and re-serialize it to the one
 * **canonical** CommonMark + GFM form (`serializeMarkdown ∘ parseMarkdown`).
 *
 * This is the single round-trip used everywhere a note's bytes are persisted —
 * commit-on-save ({@link writeNote}) and autosave-to-wip (`core/sync`) — so the
 * same logical content always lands as byte-identical Markdown. Because
 * {@link serializeMarkdown} is deterministic and idempotent, canonicalizing an
 * already-canonical string is a no-op (`canonicalize(canonicalize(x)) ===
 * canonicalize(x)`), making it safe to apply more than once along the save path.
 */
export function canonicalizeMarkdown(markdown: string): string {
  return serializeMarkdown(parseMarkdown(markdown));
}
