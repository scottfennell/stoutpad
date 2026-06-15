import { describe, expect, it } from "vitest";
import {
  applyNoteMutationToFiles,
  buildNoteTree,
  createNote,
  moveNote,
  NoteMutationError,
  planCreateNote,
  planMoveNote,
  planRenameNote,
  renameNote,
  slugifyNoteName,
  type NoteFile,
  type NoteMutation,
  type NoteNode,
} from "./index.js";

/** Build a file set from bare paths. */
function files(...paths: string[]): NoteFile[] {
  return paths.map((path) => ({ path }));
}

/** Sorted resulting paths after applying a mutation to a file set. */
function applied(start: NoteFile[], mutation: NoteMutation): string[] {
  return applyNoteMutationToFiles(start, mutation).map((f) => f.path);
}

/** Find a descendant note by its tree path. */
function find(node: NoteNode, path: string): NoteNode | undefined {
  if (node.path === path) return node;
  for (const child of node.children) {
    const hit = find(child, path);
    if (hit) return hit;
  }
  return undefined;
}

describe("slugifyNoteName", () => {
  it("kebab-cases a human name so it round-trips through deriveTitle", () => {
    expect(slugifyNoteName("My Ideas")).toBe("my-ideas");
    expect(slugifyNoteName("Hello, World!")).toBe("hello-world");
    expect(slugifyNoteName("  spaced  out  ")).toBe("spaced-out");
  });

  it("drops a trailing .md and unusable characters", () => {
    expect(slugifyNoteName("Notes.md")).toBe("notes");
    expect(slugifyNoteName("***")).toBe("");
  });
});

describe("planCreateNote", () => {
  it("creates a leaf file under the root note", () => {
    const start = files("_index.md");
    const plan = planCreateNote(start, "", "My Ideas");

    expect(plan.notePath).toBe("my-ideas");
    expect(plan.file).toBe("my-ideas.md");
    expect(plan.creates).toEqual([{ path: "my-ideas.md", content: "# My Ideas\n" }]);
    expect(plan.moves).toEqual([]);
    expect(applied(start, plan)).toEqual(["_index.md", "my-ideas.md"]);
  });

  it("promotes a leaf parent to a directory when it gains its first child", () => {
    const start = files("_index.md", "projects.md");
    const plan = planCreateNote(start, "projects", "First Idea");

    // The leaf `projects.md` becomes `projects/_index.md` (promotion), and the
    // new child lands beside it — the parent keeps its `projects` identity.
    expect(plan.moves).toEqual([
      { from: "projects.md", to: "projects/_index.md", kind: "file" },
    ]);
    expect(plan.creates).toEqual([
      { path: "projects/first-idea.md", content: "# First Idea\n" },
    ]);

    const root = buildNoteTree(applyNoteMutationToFiles(start, plan));
    const projects = find(root, "projects")!;
    expect(projects).toMatchObject({ kind: "parent", file: "projects/_index.md" });
    expect(projects.children.map((c) => c.path)).toEqual(["projects/first-idea"]);
  });

  it("adds a second child without re-promoting an existing parent", () => {
    const start = files("_index.md", "projects/_index.md", "projects/a.md");
    const plan = planCreateNote(start, "projects", "B");

    expect(plan.moves).toEqual([]);
    expect(plan.creates).toEqual([{ path: "projects/b.md", content: "# B\n" }]);
  });

  it("rejects an empty name and a duplicate identity", () => {
    const start = files("_index.md", "notes.md");
    expect(() => planCreateNote(start, "", "***")).toThrow(NoteMutationError);
    expect(() => planCreateNote(start, "", "Notes")).toThrow(/already exists/u);
  });

  it("rejects creating under a non-existent parent", () => {
    expect(() => planCreateNote(files("_index.md"), "ghost", "Child")).toThrow(
      /parent note does not exist/u,
    );
  });
});

describe("planRenameNote", () => {
  it("renames a leaf note's file in place", () => {
    const start = files("_index.md", "projects/_index.md", "projects/ideas.md");
    const plan = planRenameNote(start, "projects/ideas", "Concepts");

    expect(plan.notePath).toBe("projects/concepts");
    expect(plan.moves).toEqual([
      { from: "projects/ideas.md", to: "projects/concepts.md", kind: "file" },
    ]);
    expect(applied(start, plan)).toEqual([
      "_index.md",
      "projects/_index.md",
      "projects/concepts.md",
    ]);
  });

  it("renames a parent note by moving its whole subtree as one dir move", () => {
    const start = files(
      "_index.md",
      "projects/_index.md",
      "projects/ideas.md",
      "projects/sub/_index.md",
      "projects/sub/deep.md",
    );
    const plan = planRenameNote(start, "projects", "Work");

    expect(plan.moves).toEqual([{ from: "projects", to: "work", kind: "dir" }]);
    expect(plan.file).toBe("work/_index.md");
    expect(applied(start, plan)).toEqual([
      "_index.md",
      "work/_index.md",
      "work/ideas.md",
      "work/sub/_index.md",
      "work/sub/deep.md",
    ]);
  });

  it("treats renaming to the same name as a no-op plan", () => {
    const start = files("_index.md", "notes.md");
    const plan = planRenameNote(start, "notes", "Notes");
    expect(plan.moves).toEqual([]);
    expect(plan.creates).toEqual([]);
  });

  it("rejects renaming the root and renaming onto an existing sibling", () => {
    const start = files("_index.md", "a.md", "b.md");
    expect(() => planRenameNote(start, "", "X")).toThrow(/root/u);
    expect(() => planRenameNote(start, "a", "B")).toThrow(/already exists/u);
  });
});

describe("planMoveNote", () => {
  it("moves a leaf under a different existing parent", () => {
    const start = files("_index.md", "notes.md", "projects/_index.md");
    const plan = planMoveNote(start, "notes", "projects");

    expect(plan.notePath).toBe("projects/notes");
    expect(plan.moves).toEqual([
      { from: "notes.md", to: "projects/notes.md", kind: "file" },
    ]);
    expect(applied(start, plan)).toEqual([
      "_index.md",
      "projects/_index.md",
      "projects/notes.md",
    ]);
  });

  it("promotes a leaf destination as it receives its first child", () => {
    const start = files("_index.md", "notes.md", "archive.md");
    const plan = planMoveNote(start, "notes", "archive");

    expect(plan.moves).toEqual([
      { from: "archive.md", to: "archive/_index.md", kind: "file" },
      { from: "notes.md", to: "archive/notes.md", kind: "file" },
    ]);
    expect(applied(start, plan)).toEqual([
      "_index.md",
      "archive/_index.md",
      "archive/notes.md",
    ]);
  });

  it("collapses the source parent back to a leaf when its last child leaves", () => {
    const start = files("_index.md", "a/_index.md", "a/only.md");
    const plan = planMoveNote(start, "a/only", "");

    // Destination is root (no promotion); the note moves out; `a` loses its last
    // child and collapses `a/_index.md` → `a.md`.
    expect(plan.moves).toEqual([
      { from: "a/only.md", to: "only.md", kind: "file" },
      { from: "a/_index.md", to: "a.md", kind: "file" },
    ]);
    const root = buildNoteTree(applyNoteMutationToFiles(start, plan));
    expect(find(root, "a")).toMatchObject({ kind: "leaf", file: "a.md" });
    expect(find(root, "only")).toMatchObject({ kind: "leaf", file: "only.md" });
  });

  it("does NOT collapse a source parent that keeps another child", () => {
    const start = files("_index.md", "a/_index.md", "a/one.md", "a/two.md");
    const plan = planMoveNote(start, "a/one", "");
    expect(plan.moves).toEqual([
      { from: "a/one.md", to: "one.md", kind: "file" },
    ]);
  });

  it("moves a parent's entire subtree and collapses+promotes in one mutation", () => {
    const start = files(
      "_index.md",
      "research/_index.md",
      "research/topic/_index.md",
      "research/topic/sub.md",
      "inbox.md",
    );
    // Move parent `research/topic` (subtree) under leaf `inbox`.
    const plan = planMoveNote(start, "research/topic", "inbox");

    expect(plan.moves).toEqual([
      { from: "inbox.md", to: "inbox/_index.md", kind: "file" }, // promote dest
      { from: "research/topic", to: "inbox/topic", kind: "dir" }, // subtree move
      { from: "research/_index.md", to: "research.md", kind: "file" }, // collapse src
    ]);
    expect(applied(start, plan)).toEqual([
      "_index.md",
      "inbox/_index.md",
      "inbox/topic/_index.md",
      "inbox/topic/sub.md",
      "research.md",
    ]);
  });

  it("rejects moving a note into itself or its own descendant", () => {
    const start = files("_index.md", "a/_index.md", "a/b.md");
    expect(() => planMoveNote(start, "a", "a")).toThrow(/own subtree/u);
    expect(() => planMoveNote(start, "a", "a/b")).toThrow(/own subtree/u);
  });

  it("treats moving to the current parent as a no-op", () => {
    const start = files("_index.md", "projects/_index.md", "projects/x.md");
    expect(planMoveNote(start, "projects/x", "projects").moves).toEqual([]);
  });
});

/**
 * In-memory {@link MutatingGitEngine}: a path→content map that applies a mutation
 * by replaying its moves/creates/removes — the mutation analogue of the
 * `WritableGitEngine` double, so the compositions are tested without real Git.
 */
class InMemoryMutatingEngine {
  readonly files = new Map<string, string>();
  readonly commits: string[] = [];

  constructor(seed: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(seed)) this.files.set(path, content);
  }

  async listNoteFiles(): Promise<NoteFile[]> {
    return [...this.files.keys()].map((path) => ({ path }));
  }

  async applyNoteMutation(mutation: NoteMutation): Promise<void> {
    for (const move of mutation.moves) {
      if (move.kind === "file") {
        this.rename(move.from, move.to);
      } else {
        for (const path of [...this.files.keys()]) {
          if (path === move.from || path.startsWith(`${move.from}/`)) {
            this.rename(path, `${move.to}${path.slice(move.from.length)}`);
          }
        }
      }
    }
    for (const create of mutation.creates) this.files.set(create.path, create.content);
    for (const remove of mutation.removes) this.files.delete(remove);
    if (mutation.moves.length || mutation.creates.length || mutation.removes.length) {
      this.commits.push(mutation.message);
    }
  }

  private rename(from: string, to: string): void {
    const content = this.files.get(from) ?? "";
    this.files.delete(from);
    this.files.set(to, content);
  }
}

describe("createNote / renameNote / moveNote (compositions over the seam)", () => {
  it("createNote promotes a leaf parent and writes the child in one commit", async () => {
    const engine = new InMemoryMutatingEngine({
      "_index.md": "# Home\n",
      "projects.md": "# Projects\n",
    });

    const res = await createNote(engine, "projects", "Idea One");

    expect(res).toEqual({ path: "projects/idea-one", file: "projects/idea-one.md" });
    // Promotion preserved the parent's content under its new backing file.
    expect(engine.files.get("projects/_index.md")).toBe("# Projects\n");
    expect(engine.files.has("projects.md")).toBe(false);
    expect(engine.files.get("projects/idea-one.md")).toBe("# Idea One\n");
    expect(engine.commits).toHaveLength(1);
  });

  it("renameNote moves a parent's whole subtree", async () => {
    const engine = new InMemoryMutatingEngine({
      "_index.md": "# Home\n",
      "projects/_index.md": "# Projects\n",
      "projects/ideas.md": "# Ideas\n",
    });

    const res = await renameNote(engine, "projects", "Work");

    expect(res.path).toBe("work");
    expect([...engine.files.keys()].sort()).toEqual([
      "_index.md",
      "work/_index.md",
      "work/ideas.md",
    ]);
    expect(engine.files.get("work/ideas.md")).toBe("# Ideas\n");
  });

  it("moveNote collapses the emptied source parent", async () => {
    const engine = new InMemoryMutatingEngine({
      "_index.md": "# Home\n",
      "a/_index.md": "# A\n",
      "a/only.md": "# Only\n",
    });

    const res = await moveNote(engine, "a/only", "");

    expect(res).toEqual({ path: "only", file: "only.md" });
    expect([...engine.files.keys()].sort()).toEqual(["_index.md", "a.md", "only.md"]);
    expect(engine.files.get("a.md")).toBe("# A\n"); // content preserved on collapse
  });
});
