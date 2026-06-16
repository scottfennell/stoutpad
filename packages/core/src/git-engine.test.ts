import { describe, expect, it } from "vitest";
import {
  readLinkGraph,
  readNote,
  readNoteTree,
  readSearchableNotes,
  writeNote,
  type NoteFile,
  type NoteNode,
  type WritableGitEngine,
} from "./index.js";

interface Commit {
  message: string;
  file: string;
  content: string;
}

/**
 * In-memory {@link WritableGitEngine}: a file map plus a commit log.
 *
 * Mirrors the migration runner's `MigrationStore` pattern — an interface with an
 * in-memory test double — so {@link writeNote}'s canonicalize-and-commit behavior
 * is exercised without touching real Git. It reproduces the Node impl's "no empty
 * commit" rule: writing identical content records no commit.
 */
class InMemoryGitEngine implements WritableGitEngine {
  readonly files = new Map<string, string>();
  readonly commits: Commit[] = [];

  constructor(seed: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(seed)) {
      this.files.set(path, content);
    }
  }

  async listNoteFiles(): Promise<NoteFile[]> {
    return [...this.files.keys()].map((path) => ({ path }));
  }

  async readNoteFile(path: string): Promise<string | null> {
    return this.files.has(path) ? (this.files.get(path) as string) : null;
  }

  async writeNoteFile(path: string, content: string, message: string): Promise<void> {
    if (this.files.get(path) === content) return; // no-op: no empty commit
    this.files.set(path, content);
    this.commits.push({ message, file: path, content });
  }
}

describe("writeNote", () => {
  it("canonicalizes the markdown, writes the leaf file, and commits once", async () => {
    const engine = new InMemoryGitEngine({ "notes.md": "# Notes\n" });

    const saved = await writeNote(engine, "notes", "#  Notes\n\n*  a\n+  b\n");

    // The response and the file both hold canonical CommonMark + GFM.
    expect(saved).toEqual({
      path: "notes",
      file: "notes.md",
      markdown: "# Notes\n\n- a\n- b\n",
    });
    expect(engine.files.get("notes.md")).toBe("# Notes\n\n- a\n- b\n");
    expect(engine.commits).toHaveLength(1);
    expect(engine.commits[0]).toMatchObject({ file: "notes.md" });
  });

  it("reload (readNote) reflects the persisted, canonical content", async () => {
    const engine = new InMemoryGitEngine({ "notes.md": "# Notes\n" });

    await writeNote(engine, "notes", "# Notes\n\nFresh **content**.\n");

    expect(await readNote(engine, "notes")).toEqual({
      path: "notes",
      file: "notes.md",
      markdown: "# Notes\n\nFresh **content**.\n",
    });
  });

  it("writes a parent note to its _index.md, not a sibling leaf", async () => {
    const engine = new InMemoryGitEngine({ "projects/_index.md": "# Projects\n" });

    const saved = await writeNote(engine, "projects", "# Projects\n\nUpdated.\n");

    expect(saved.file).toBe("projects/_index.md");
    expect(engine.files.get("projects/_index.md")).toBe("# Projects\n\nUpdated.\n");
  });

  it("saves the root note to the repo-root _index.md", async () => {
    const engine = new InMemoryGitEngine({ "_index.md": "# Home\n" });

    const saved = await writeNote(engine, "", "# Home\n\nWelcome.\n");

    expect(saved.file).toBe("_index.md");
    expect(engine.files.get("_index.md")).toBe("# Home\n\nWelcome.\n");
  });

  it("creates a new leaf file when the note does not exist yet", async () => {
    const engine = new InMemoryGitEngine();

    const saved = await writeNote(engine, "fresh", "# Fresh\n");

    expect(saved.file).toBe("fresh.md");
    expect(engine.files.get("fresh.md")).toBe("# Fresh\n");
    expect(engine.commits).toHaveLength(1);
  });

  it("makes commit-on-save idempotent: saving unchanged content commits nothing", async () => {
    const engine = new InMemoryGitEngine({ "notes.md": "# Notes\n" });

    // Saving the same canonical content is a no-op (no empty commit).
    await writeNote(engine, "notes", "# Notes\n");
    expect(engine.commits).toHaveLength(0);

    // A real change commits once; repeating it commits nothing further.
    await writeNote(engine, "notes", "# Changed\n");
    await writeNote(engine, "notes", "# Changed\n");
    expect(engine.commits).toHaveLength(1);
  });
});

describe("readNoteTree", () => {
  /** Find a descendant node by its tree path. */
  const find = (node: NoteNode, path: string): NoteNode | undefined => {
    if (node.path === path) return node;
    for (const child of node.children) {
      const hit = find(child, path);
      if (hit) return hit;
    }
    return undefined;
  };

  it("overrides derived titles with each note's frontmatter title", async () => {
    const engine = new InMemoryGitEngine({
      "_index.md": "---\ntitle: My Brain\n---\n\n# Home\n",
      "first_draft.md": "---\ntitle: Grand Plans\ntags: [todo]\n---\n\nbody\n",
      "plain.md": "# Plain\n",
    });

    const { root } = await readNoteTree(engine);

    // Root and leaf titles come from frontmatter...
    expect(root.title).toBe("My Brain");
    expect(find(root, "first_draft")!.title).toBe("Grand Plans");
    // ...while a note without frontmatter keeps its file-derived title.
    expect(find(root, "plain")!.title).toBe("Plain");
  });
});

describe("readLinkGraph", () => {
  it("reads every note and builds the resolved + broken link graph", async () => {
    const engine = new InMemoryGitEngine({
      "_index.md": "# Home\n\nStart at [[Projects]].\n",
      "projects/_index.md": "# Projects\n\nSee [[Ideas]] and [[Ghost]].\n",
      "projects/ideas.md": "# Ideas\n\nback [[Home]]\n",
    });

    const graph = await readLinkGraph(engine);

    expect(graph.edges).toEqual([
      { from: "", to: "projects" },
      { from: "projects", to: "projects/ideas" },
      { from: "projects/ideas", to: "" },
    ]);
    expect(graph.broken).toEqual([{ from: "projects", target: "Ghost" }]);
  });
});

describe("readSearchableNotes", () => {
  it("reads every note's identity, title, and markdown in tree order", async () => {
    const engine = new InMemoryGitEngine({
      "_index.md": "# Home\n\nWelcome.\n",
      "projects/_index.md": "# Projects\n\nWork.\n",
      "projects/ideas.md": "# Ideas\n\nThoughts.\n",
    });

    const notes = await readSearchableNotes(engine);

    expect(notes).toEqual([
      { path: "", title: "Home", markdown: "# Home\n\nWelcome.\n" },
      { path: "projects", title: "Projects", markdown: "# Projects\n\nWork.\n" },
      { path: "projects/ideas", title: "Ideas", markdown: "# Ideas\n\nThoughts.\n" },
    ]);
  });
});
