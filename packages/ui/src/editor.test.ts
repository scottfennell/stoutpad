import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import {
  filterTitles,
  markdownToTipTapDoc,
  scanWikiLinks,
  tipTapDocToMarkdown,
  wikiLinkQuery,
} from "./editor.js";

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

describe("wikiLinkQuery", () => {
  it("returns the text typed after the nearest unclosed [[", () => {
    expect(wikiLinkQuery("see [[Pro")).toBe("Pro");
    expect(wikiLinkQuery("[[Note Name")).toBe("Note Name");
    // Just-opened link: an empty (but non-null) query.
    expect(wikiLinkQuery("[[")).toBe("");
    // The most recent open link wins.
    expect(wikiLinkQuery("[[Done]] then [[Nex")).toBe("Nex");
  });

  it("returns null when the caret is not inside an open wikilink", () => {
    expect(wikiLinkQuery("no brackets here")).toBeNull();
    // A closed link is not in-progress.
    expect(wikiLinkQuery("[[Home]]")).toBeNull();
    // A pipe starts an alias, ending the title query.
    expect(wikiLinkQuery("[[Target|al")).toBeNull();
    // A newline breaks out of the link.
    expect(wikiLinkQuery("[[Multi\nline")).toBeNull();
    expect(wikiLinkQuery("")).toBeNull();
  });
});

describe("filterTitles", () => {
  it("ranks case-insensitive substring matches by earliest match, then alphabetically", () => {
    // 'a' appears at offset 0 in Apple, 1 in Banana, 2 in Grape; Cherry has none.
    expect(filterTitles(["Banana", "Grape", "Apple", "Cherry"], "a")).toEqual([
      "Apple",
      "Banana",
      "Grape",
    ]);
    // Equal offsets fall back to alphabetical order.
    expect(filterTitles(["Prologue", "Project"], "pro")).toEqual([
      "Project",
      "Prologue",
    ]);
  });

  it("dedupes titles that normalize alike and caps the result at the limit", () => {
    expect(filterTitles(["Note", "note", "NOTE"], "note")).toEqual(["Note"]);
    // An empty query returns the first `limit` titles in order.
    expect(filterTitles(["a", "b", "c", "d"], "", 2)).toEqual(["a", "b"]);
  });
});

describe("scanWikiLinks", () => {
  it("finds each [[link]] with its character offsets and parsed target", () => {
    const [match] = scanWikiLinks("Link to [[Home]] here");
    expect(match.start).toBe(8);
    expect(match.end).toBe(16);
    expect(match.link).toEqual({ target: "Home" });
  });

  it("parses an alias and scans multiple links in order", () => {
    const matches = scanWikiLinks("[[Target|Alias]] and [[Other]]");
    expect(matches.map((m) => m.link)).toEqual([
      { target: "Target", alias: "Alias" },
      { target: "Other" },
    ]);
  });

  it("skips an empty-target [[ ]] (not a link)", () => {
    expect(scanWikiLinks("before [[ ]] after")).toEqual([]);
  });
});
