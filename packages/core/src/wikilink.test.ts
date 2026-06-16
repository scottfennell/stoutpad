import { describe, expect, it } from "vitest";
import { buildNoteTree } from "./note-tree.js";
import {
  buildLinkGraph,
  buildTitleIndex,
  normalizeTitle,
  resolveTitle,
  resolveWikiLink,
  type NoteContent,
} from "./wikilink.js";

/** A representative workspace: a root, a nested parent, and two leaves. */
const TREE = buildNoteTree([
  { path: "_index.md" },
  { path: "projects/_index.md" },
  { path: "projects/ideas.md" },
  { path: "shopping.md" },
]);

describe("normalizeTitle", () => {
  it("lowercases, trims, and collapses internal whitespace", () => {
    expect(normalizeTitle("  Note   Name ")).toBe("note name");
  });
});

describe("buildTitleIndex", () => {
  it("indexes every note title and lists them in tree order", () => {
    const index = buildTitleIndex(TREE);
    // Home (root), then sorted children: Projects (+ its child Ideas), Shopping.
    expect(index.titles).toEqual(["Home", "Projects", "Ideas", "Shopping"]);
    expect(index.byTitle.get("ideas")).toEqual(["projects/ideas"]);
    expect(index.byTitle.get("home")).toEqual([""]);
  });
});

describe("resolveTitle", () => {
  const index = buildTitleIndex(TREE);

  it("resolves a title to its note path, case- and space-insensitively", () => {
    expect(resolveTitle(index, "Projects")).toBe("projects");
    expect(resolveTitle(index, "  ideas ")).toBe("projects/ideas");
    expect(resolveTitle(index, "SHOPPING")).toBe("shopping");
  });

  it("resolves the root note's title to the empty-string path", () => {
    expect(resolveTitle(index, "Home")).toBe("");
  });

  it("returns null for a title no note bears", () => {
    expect(resolveTitle(index, "Nonexistent")).toBeNull();
  });
});

describe("resolveWikiLink", () => {
  const index = buildTitleIndex(TREE);

  it("resolves a link and carries its alias through", () => {
    expect(resolveWikiLink(index, { target: "Ideas", alias: "my ideas" })).toEqual({
      target: "Ideas",
      alias: "my ideas",
      path: "projects/ideas",
      broken: false,
    });
  });

  it("flags a link to a missing note as broken", () => {
    expect(resolveWikiLink(index, { target: "Ghost" })).toEqual({
      target: "Ghost",
      path: null,
      broken: true,
    });
  });
});

describe("buildLinkGraph", () => {
  const index = buildTitleIndex(TREE);

  it("builds resolved edges between notes by title", () => {
    const notes: NoteContent[] = [
      { path: "", title: "Home", markdown: "Start at [[Projects]].\n" },
      {
        path: "projects",
        title: "Projects",
        markdown: "See [[Ideas]] and [[Shopping]].\n",
      },
      { path: "projects/ideas", title: "Ideas", markdown: "back to [[Home]]\n" },
      { path: "shopping", title: "Shopping", markdown: "no links\n" },
    ];

    const graph = buildLinkGraph(notes, index);

    expect(graph.edges).toEqual([
      { from: "", to: "projects" },
      { from: "projects", to: "projects/ideas" },
      { from: "projects", to: "shopping" },
      { from: "projects/ideas", to: "" },
    ]);
    expect(graph.broken).toEqual([]);
  });

  it("collects broken links to non-existent titles", () => {
    const notes: NoteContent[] = [
      {
        path: "shopping",
        title: "Shopping",
        markdown: "buy [[Milk]] and visit [[Ghost Town]]\n",
      },
    ];

    const graph = buildLinkGraph(notes, index);

    expect(graph.edges).toEqual([]);
    expect(graph.broken).toEqual([
      { from: "shopping", target: "Ghost Town" },
      { from: "shopping", target: "Milk" },
    ]);
  });

  it("deduplicates repeated links and ignores self-links", () => {
    const notes: NoteContent[] = [
      {
        path: "projects",
        title: "Projects",
        // Two links to Ideas, plus a self-link back to Projects.
        markdown: "[[Ideas]] again [[ideas]] and self [[Projects]]\n",
      },
    ];

    const graph = buildLinkGraph(notes, index);

    expect(graph.edges).toEqual([{ from: "projects", to: "projects/ideas" }]);
    expect(graph.broken).toEqual([]);
  });

  it("is deterministic: edges and broken links come out sorted", () => {
    const notes: NoteContent[] = [
      {
        path: "shopping",
        title: "Shopping",
        markdown: "[[Projects]] [[Home]] [[Zzz]] [[Aaa]]\n",
      },
    ];

    const graph = buildLinkGraph(notes, index);

    expect(graph.edges).toEqual([
      { from: "shopping", to: "" },
      { from: "shopping", to: "projects" },
    ]);
    expect(graph.broken).toEqual([
      { from: "shopping", target: "Aaa" },
      { from: "shopping", target: "Zzz" },
    ]);
  });
});
