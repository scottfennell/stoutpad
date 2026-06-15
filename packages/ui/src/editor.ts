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
  type InlineMark,
  type MarkdownBlock,
  type MarkdownSpan,
} from "@stout/core";
import type { ReactElement } from "react";

/** "Markdown in, change events out" — the contract every Editor honors. */
export interface EditorProps {
  /** Canonical Markdown content of the note to render. */
  markdown: string;
  /** Called with the updated Markdown whenever the user edits. */
  onChange?: (markdown: string) => void;
  /** Whether the note is editable (default `true`). */
  editable?: boolean;
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
