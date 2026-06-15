import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { markdownToTipTapDoc, tipTapDocToMarkdown } from "./editor.js";

const SAMPLE = `# Shopping

Things to **buy** today:

- [x] Milk
- [ ] Eggs

## Notes

- Organic only
`;

describe("markdownToTipTapDoc", () => {
  it("maps headings, formatted prose, and checkboxes to ProseMirror nodes", () => {
    const doc = markdownToTipTapDoc(SAMPLE);

    expect(doc.type).toBe("doc");
    const types = (doc.content ?? []).map((node) => node.type);
    expect(types).toEqual([
      "heading",
      "paragraph",
      "taskList",
      "heading",
      "bulletList",
    ]);

    // The checkbox list keeps each item's checked state as a node attribute.
    const taskList = (doc.content ?? []).find((n) => n.type === "taskList");
    expect((taskList?.content ?? []).map((item) => item.attrs?.checked)).toEqual([
      true,
      false,
    ]);

    // Inline bold becomes a marked text node.
    const paragraph = (doc.content ?? []).find((n) => n.type === "paragraph");
    const bold = (paragraph?.content ?? []).find((n) =>
      (n.marks ?? []).some((mark) => mark.type === "bold"),
    );
    expect(bold?.text).toBe("buy");
  });

  it("never produces empty text nodes (a paragraph with no text has no content)", () => {
    const doc = markdownToTipTapDoc("\n\n");
    expect(doc.content).toEqual([{ type: "paragraph" }]);
  });
});

describe("tipTapDocToMarkdown round-trip", () => {
  it("serializes a parsed doc back to equivalent Markdown", () => {
    const markdown = tipTapDocToMarkdown(markdownToTipTapDoc(SAMPLE));
    expect(markdown).toBe(SAMPLE);
  });

  it("renders checkbox state as GFM task syntax", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [{ type: "paragraph", content: [{ type: "text", text: "ship" }] }],
            },
          ],
        },
      ],
    };
    expect(tipTapDocToMarkdown(doc)).toBe("- [x] ship\n");
  });
});
