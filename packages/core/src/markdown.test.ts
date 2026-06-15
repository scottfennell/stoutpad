import { describe, expect, it } from "vitest";
import {
  parseInline,
  parseMarkdown,
  spansToPlainText,
  type MarkdownDocument,
} from "./markdown.js";

/** A representative note exercising headings, prose, checkboxes, and bullets. */
const SAMPLE = `# Shopping

Things to **buy** today:

- [x] Milk
- [ ] Eggs
- [ ] Bread

## Notes

- Organic only
- Check \`expiry\` dates
`;

describe("parseMarkdown", () => {
  it("parses a representative note into ordered blocks", () => {
    const doc: MarkdownDocument = parseMarkdown(SAMPLE);

    expect(doc.blocks).toEqual([
      { type: "heading", level: 1, text: "Shopping" },
      { type: "paragraph", text: "Things to **buy** today:" },
      {
        type: "taskList",
        items: [
          { checked: true, text: "Milk" },
          { checked: false, text: "Eggs" },
          { checked: false, text: "Bread" },
        ],
      },
      { type: "heading", level: 2, text: "Notes" },
      { type: "bulletList", items: ["Organic only", "Check `expiry` dates"] },
    ]);
  });

  it("reads checkbox state from `[x]` and `[ ]` (case-insensitive)", () => {
    const doc = parseMarkdown("- [X] done\n- [ ] todo\n");
    expect(doc.blocks).toEqual([
      {
        type: "taskList",
        items: [
          { checked: true, text: "done" },
          { checked: false, text: "todo" },
        ],
      },
    ]);
  });

  it("keeps task and plain bullet runs as separate blocks", () => {
    const doc = parseMarkdown("- plain\n- [ ] task\n");
    expect(doc.blocks.map((b) => b.type)).toEqual(["bulletList", "taskList"]);
  });

  it("returns an empty block list for empty input", () => {
    expect(parseMarkdown("")).toEqual({ blocks: [] });
  });

  it("supports `*` and `+` bullet markers", () => {
    const doc = parseMarkdown("* one\n+ two\n");
    expect(doc.blocks).toEqual([
      { type: "bulletList", items: ["one", "two"] },
    ]);
  });
});

describe("parseInline", () => {
  it("splits bold, italic and code runs out of surrounding text", () => {
    expect(parseInline("a **b** c *d* e `f`")).toEqual([
      { text: "a ", marks: [] },
      { text: "b", marks: ["bold"] },
      { text: " c ", marks: [] },
      { text: "d", marks: ["italic"] },
      { text: " e ", marks: [] },
      { text: "f", marks: ["code"] },
    ]);
  });

  it("returns a single empty span for empty text", () => {
    expect(parseInline("")).toEqual([{ text: "", marks: [] }]);
  });

  it("round-trips to plain text via spansToPlainText", () => {
    expect(spansToPlainText(parseInline("a **b** c"))).toBe("a b c");
  });
});
