import { describe, expect, it } from "vitest";
import {
  readNote,
  writeNote,
  type NoteFile,
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
