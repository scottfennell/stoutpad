import { describe, expect, it } from "vitest";
import {
  buildNoteTree,
  deriveTitle,
  type NoteFile,
  type NoteNode,
} from "./note-tree.js";

/** Convenience: build a tree from bare paths. */
function tree(...paths: string[]): NoteNode {
  return buildNoteTree(paths.map((path): NoteFile => ({ path })));
}

/** Find a descendant by its tree path. */
function find(node: NoteNode, path: string): NoteNode | undefined {
  if (node.path === path) return node;
  for (const child of node.children) {
    const hit = find(child, path);
    if (hit) return hit;
  }
  return undefined;
}

describe("buildNoteTree", () => {
  it("returns a root note even with no files", () => {
    const root = buildNoteTree([]);
    expect(root).toMatchObject({ path: "", kind: "parent", children: [] });
    expect(root.title).toBe("Home");
    expect(root.file).toBeNull();
  });

  it("backs the root note with the repo-root _index.md", () => {
    const root = tree("_index.md");
    expect(root.file).toBe("_index.md");
    expect(root.kind).toBe("parent");
    expect(root.children).toHaveLength(0);
  });

  it("maps top-level files into leaf notes", () => {
    const root = tree("_index.md", "alpha.md", "beta.md");

    expect(root.children.map((c) => c.title)).toEqual(["Alpha", "Beta"]);
    const alpha = find(root, "alpha")!;
    expect(alpha).toMatchObject({
      path: "alpha",
      title: "Alpha",
      file: "alpha.md",
      kind: "leaf",
      children: [],
    });
  });

  it("treats a directory with an _index.md as a parent note", () => {
    const root = tree("_index.md", "projects/_index.md", "projects/ideas.md");

    const projects = find(root, "projects")!;
    expect(projects).toMatchObject({
      path: "projects",
      title: "Projects",
      file: "projects/_index.md",
      kind: "parent",
    });
    // The _index.md is the parent's backing file, NOT a child note named "_index".
    expect(projects.children.map((c) => c.path)).toEqual(["projects/ideas"]);
    expect(find(root, "projects/ideas")).toMatchObject({
      title: "Ideas",
      file: "projects/ideas.md",
      kind: "leaf",
    });
  });

  it("derives parent titles from the folder and leaf titles from the file", () => {
    const root = tree(
      "_index.md",
      "my-research/_index.md",
      "my-research/first_draft.md",
    );

    expect(find(root, "my-research")!.title).toBe("My Research");
    expect(find(root, "my-research/first_draft")!.title).toBe("First Draft");
  });

  it("synthesizes implied parents for nested files without an _index.md", () => {
    const root = tree("_index.md", "a/b/c.md");

    const a = find(root, "a")!;
    const ab = find(root, "a/b")!;
    expect(a).toMatchObject({ kind: "parent", file: null, title: "A" });
    expect(ab).toMatchObject({ kind: "parent", file: null, title: "B" });
    expect(find(root, "a/b/c")).toMatchObject({
      kind: "leaf",
      file: "a/b/c.md",
    });
  });

  it("is independent of input order", () => {
    const paths = [
      "_index.md",
      "projects/_index.md",
      "projects/ideas.md",
      "projects/sub/_index.md",
      "projects/sub/deep.md",
      "notes.md",
    ];
    const forward = buildNoteTree(paths.map((path) => ({ path })));
    const reversed = buildNoteTree(
      [...paths].reverse().map((path) => ({ path })),
    );
    expect(reversed).toEqual(forward);
  });

  it("ignores non-Markdown files such as attachments", () => {
    const root = tree("_index.md", "diagram.png", "notes.md");
    expect(root.children.map((c) => c.path)).toEqual(["notes"]);
  });

  it("sorts children by title", () => {
    const root = tree("_index.md", "zebra.md", "apple.md", "mango.md");
    expect(root.children.map((c) => c.title)).toEqual([
      "Apple",
      "Mango",
      "Zebra",
    ]);
  });

  it("lets the caller name the root note", () => {
    expect(buildNoteTree([], { rootTitle: "Workspace" }).title).toBe(
      "Workspace",
    );
  });
});

describe("deriveTitle", () => {
  it("drops the .md extension", () => {
    expect(deriveTitle("ideas.md")).toBe("Ideas");
  });

  it("humanizes separators and capitalizes words", () => {
    expect(deriveTitle("my-first-note.md")).toBe("My First Note");
    expect(deriveTitle("release_notes")).toBe("Release Notes");
  });
});
