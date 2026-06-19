import { describe, expect, it } from "vitest";
import {
  canonicalizeMarkdown,
  extractWikiLinks,
  parseFrontmatter,
  parseInline,
  parseMarkdown,
  parseWikiLink,
  serializeMarkdown,
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

const WITH_CODE_BLOCK = `# Mermaid

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

After the diagram.
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

  it("parses fenced code blocks with an optional language tag", () => {
    const doc = parseMarkdown(WITH_CODE_BLOCK);
    expect(doc.blocks).toEqual([
      { type: "heading", level: 1, text: "Mermaid" },
      { type: "codeBlock", language: "mermaid", text: "graph TD\n  A --> B" },
      { type: "paragraph", text: "After the diagram." },
    ]);
  });

  it("treats an unclosed fence as a code block through end of note", () => {
    const doc = parseMarkdown("\`\`\`ts\nconst x = 1;\n");
    expect(doc.blocks).toEqual([
      { type: "codeBlock", language: "ts", text: "const x = 1;" },
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

  it("keeps a wikilink as one literal span carrying the parsed link", () => {
    expect(parseInline("see [[Note Name]] now")).toEqual([
      { text: "see ", marks: [] },
      { text: "[[Note Name]]", marks: [], link: { target: "Note Name" } },
      { text: " now", marks: [] },
    ]);
  });

  it("carries the alias of a `[[target|alias]]` link", () => {
    expect(parseInline("[[home|Start here]]")).toEqual([
      {
        text: "[[home|Start here]]",
        marks: [],
        link: { target: "home", alias: "Start here" },
      },
    ]);
  });

  it("does not re-interpret formatting inside a wikilink", () => {
    // The `*` inside the link must not become italic — the link is atomic.
    expect(parseInline("[[a *b* c]]")).toEqual([
      { text: "[[a *b* c]]", marks: [], link: { target: "a *b* c" } },
    ]);
  });

  it("treats an empty-target `[[ ]]` as plain text, not a link", () => {
    expect(parseInline("x [[ ]] y")).toEqual([{ text: "x [[ ]] y", marks: [] }]);
  });
});

describe("parseWikiLink", () => {
  it("parses a bare target", () => {
    expect(parseWikiLink("Note Name")).toEqual({ target: "Note Name" });
  });

  it("splits a `target|alias` on the first pipe and trims both sides", () => {
    expect(parseWikiLink("  home  |  Start here  ")).toEqual({
      target: "home",
      alias: "Start here",
    });
  });

  it("drops an empty alias (`target|`)", () => {
    expect(parseWikiLink("home|")).toEqual({ target: "home" });
  });

  it("returns null for an empty or whitespace-only target", () => {
    expect(parseWikiLink("")).toBeNull();
    expect(parseWikiLink("   ")).toBeNull();
    expect(parseWikiLink("|alias")).toBeNull();
  });
});

describe("extractWikiLinks", () => {
  it("collects every wikilink across blocks, in document order", () => {
    const markdown = "# A\n\nlink to [[One]] and [[Two|second]].\n\n- [[Three]]\n";
    expect(extractWikiLinks(markdown)).toEqual([
      { target: "One" },
      { target: "Two", alias: "second" },
      { target: "Three" },
    ]);
  });

  it("skips empty-target links and returns [] when there are none", () => {
    expect(extractWikiLinks("no links here, just [[ ]] noise")).toEqual([]);
    expect(extractWikiLinks("plain text")).toEqual([]);
  });
});

describe("serializeMarkdown", () => {
  it("renders a representative note as canonical CommonMark + GFM", () => {
    // Headings, **bold**/*italic* prose, a bullet list and a task list.
    const blocks = parseMarkdown(SAMPLE).blocks;
    expect(serializeMarkdown(blocks)).toBe(SAMPLE);
  });

  it("accepts a MarkdownDocument as well as a bare block array", () => {
    const doc = parseMarkdown(SAMPLE);
    expect(serializeMarkdown(doc)).toBe(serializeMarkdown(doc.blocks));
  });

  it("emits the empty string for an empty note", () => {
    expect(serializeMarkdown(parseMarkdown(""))).toBe("");
  });

  it("round-trips wikilinks verbatim through canonicalization", () => {
    const note = "See [[Note Name]] and [[home|Start]].\n";
    expect(serializeMarkdown(parseMarkdown(note))).toBe(note);
  });

  it("normalizes loose Markdown to the canonical byte form", () => {
    // Mixed bullet markers, ragged checkbox casing, and extra blank lines all
    // collapse to one canonical representation.
    const loose = "#  Title\n\n*  one\n+  two\n\n\n- [X] done\n";
    expect(serializeMarkdown(parseMarkdown(loose))).toBe(
      "# Title\n\n- one\n- two\n\n- [x] done\n",
    );
  });

  it("is idempotent: serialize -> parse -> serialize is byte-stable", () => {
    const inputs = [
      SAMPLE,
      WITH_CODE_BLOCK,
      "",
      "# Only a heading\n",
      "Just a paragraph with *italic* and `code`.\n",
      "- [ ] a\n- [x] b\n\n- plain\n",
      "#  sloppy\n\n*  mixed\n+  bullets\n",
    ];
    for (const input of inputs) {
      const once = serializeMarkdown(parseMarkdown(input));
      const twice = serializeMarkdown(parseMarkdown(once));
      // The fixed point is reached after a single pass and never drifts.
      expect(twice).toBe(once);
      // parse(serialize(x)) round-trips: re-parsing canonical text is stable.
      expect(parseMarkdown(twice)).toEqual(parseMarkdown(once));
    }
  });

  it("uses a longer fence when the code contains triple backticks", () => {
    const markdown = serializeMarkdown([
      { type: "codeBlock", language: "md", text: "before\n\`\`\`\nafter" },
    ]);
    expect(markdown).toBe("\`\`\`\`md\nbefore\n\`\`\`\nafter\n\`\`\`\`\n");
  });
});

/** A note opening with a representative frontmatter block. */
const WITH_FRONTMATTER = `---
title: Trip Planning
created: 2024-01-02
updated: 2024-03-04
tags: [travel, todo]
---

# Trip Planning

- [ ] Book flights
`;

describe("parseFrontmatter", () => {
  it("splits a frontmatter block from the body", () => {
    const { frontmatter, body } = parseFrontmatter(WITH_FRONTMATTER);
    expect(frontmatter).toEqual({
      title: "Trip Planning",
      created: "2024-01-02",
      updated: "2024-03-04",
      tags: ["travel", "todo"],
    });
    expect(body).toBe("# Trip Planning\n\n- [ ] Book flights\n");
  });

  it("parses a block-sequence `- item` tag list", () => {
    const { frontmatter } = parseFrontmatter(
      "---\ntags:\n  - travel\n  - todo\n---\nbody\n",
    );
    expect(frontmatter?.tags).toEqual(["travel", "todo"]);
  });

  it("collects unknown scalar keys into `extra`", () => {
    const { frontmatter } = parseFrontmatter(
      "---\ntitle: A\nauthor: Sam\nstatus: draft\n---\n",
    );
    expect(frontmatter).toEqual({
      title: "A",
      tags: [],
      extra: { author: "Sam", status: "draft" },
    });
  });

  it("strips surrounding quotes from values", () => {
    const { frontmatter } = parseFrontmatter(
      `---\ntitle: "Hello: World"\ntags: ['a, b', c]\n---\n`,
    );
    expect(frontmatter?.title).toBe("Hello: World");
    expect(frontmatter?.tags).toEqual(["a, b", "c"]);
  });

  it("ignores blank lines and `#` comments inside the block", () => {
    const { frontmatter } = parseFrontmatter(
      "---\n# a comment\ntitle: A\n\ntags: [x]\n---\n",
    );
    expect(frontmatter).toEqual({ title: "A", tags: ["x"] });
  });

  it("returns no frontmatter when the note does not open with `---`", () => {
    expect(parseFrontmatter("# Heading\n")).toEqual({ body: "# Heading\n" });
  });

  it("returns no frontmatter when the fence is never closed", () => {
    const input = "---\ntitle: A\n# Heading\n";
    expect(parseFrontmatter(input)).toEqual({ body: input });
  });

  it("treats an empty metadata block as no frontmatter", () => {
    expect(parseFrontmatter("---\n---\nbody\n")).toEqual({ body: "body\n" });
  });
});

describe("frontmatter canonicalization", () => {
  it("attaches parsed frontmatter to the document", () => {
    const doc = parseMarkdown(WITH_FRONTMATTER);
    expect(doc.frontmatter).toEqual({
      title: "Trip Planning",
      created: "2024-01-02",
      updated: "2024-03-04",
      tags: ["travel", "todo"],
    });
    expect(doc.blocks).toEqual([
      { type: "heading", level: 1, text: "Trip Planning" },
      { type: "taskList", items: [{ checked: false, text: "Book flights" }] },
    ]);
  });

  it("round-trips a frontmatter note byte-for-byte", () => {
    expect(canonicalizeMarkdown(WITH_FRONTMATTER)).toBe(WITH_FRONTMATTER);
  });

  it("normalizes a block-sequence tag list to canonical flow form", () => {
    const loose = "---\ntitle: A\ntags:\n  - one\n  - two\n---\n\nbody\n";
    expect(canonicalizeMarkdown(loose)).toBe(
      "---\ntitle: A\ntags: [one, two]\n---\n\nbody\n",
    );
  });

  it("emits a frontmatter-only note with no trailing body", () => {
    expect(canonicalizeMarkdown("---\ntitle: A\n---\n")).toBe(
      "---\ntitle: A\n---\n",
    );
  });

  it("quotes values that would otherwise be ambiguous", () => {
    const doc: MarkdownDocument = {
      frontmatter: { title: "Plans: Q1", tags: ["a, b", "c"] },
      blocks: [{ type: "paragraph", text: "hi" }],
    };
    const serialized = serializeMarkdown(doc);
    expect(serialized).toBe('---\ntitle: "Plans: Q1"\ntags: ["a, b", c]\n---\n\nhi\n');
    // ...and it round-trips back to the same frontmatter.
    expect(parseMarkdown(serialized).frontmatter).toEqual(doc.frontmatter);
  });

  it("is idempotent on frontmatter notes", () => {
    const once = canonicalizeMarkdown(WITH_FRONTMATTER);
    const twice = canonicalizeMarkdown(once);
    expect(twice).toBe(once);
  });

  it("preserves unknown frontmatter keys through a round-trip", () => {
    const input = "---\ntitle: A\nauthor: Sam\n---\n\nbody\n";
    expect(canonicalizeMarkdown(input)).toBe(input);
  });
});
