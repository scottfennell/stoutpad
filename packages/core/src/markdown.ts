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
 * `*italic*`, `` `code` ``). Nested lists are flattened to a single level and
 * other constructs degrade to paragraphs; richer grammar lands in later slices.
 */

/** A heading level, `#` (1) through `######` (6). */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** An inline formatting mark applied to a run of text. */
export type InlineMark = "bold" | "italic" | "code";

/** A run of inline text with zero or more formatting marks. */
export interface MarkdownSpan {
  /** The literal text of the run (delimiters already stripped). */
  text: string;
  /** Formatting marks applied to this run. */
  marks: InlineMark[];
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

const INLINE = /(`+)([^`]+?)\1|(\*\*)([^*]+?)\*\*|(\*)([^*]+?)\*/su;

/**
 * Resolve a run of inline Markdown into formatted {@link MarkdownSpan spans}.
 *
 * Supports `**bold**`, `*italic*`, and `` `code` ``; marks are not nested or
 * combined. Always returns at least one span (possibly empty) so callers can map
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
      pushPlain();
      spans.push({ text: match[2], marks: ["code"] });
    } else if (match[3] !== undefined) {
      pushPlain();
      spans.push({ text: match[4], marks: ["bold"] });
    } else {
      pushPlain();
      spans.push({ text: match[6], marks: ["italic"] });
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
