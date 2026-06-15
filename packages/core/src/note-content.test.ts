import { describe, expect, it } from "vitest";
import {
  noteFileCandidates,
  normalizeNotePath,
  readNote,
  type GitEngine,
  type NoteFile,
} from "./index.js";

/** In-memory {@link GitEngine} over a fixed map of repo file → content. */
function fakeEngine(files: Record<string, string>): GitEngine {
  return {
    async listNoteFiles(): Promise<NoteFile[]> {
      return Object.keys(files).map((path) => ({ path }));
    },
    async readNoteFile(path: string): Promise<string | null> {
      return path in files ? files[path] : null;
    },
  };
}

describe("noteFileCandidates", () => {
  it("backs the root note with the repo-root _index.md", () => {
    expect(noteFileCandidates("")).toEqual(["_index.md"]);
  });

  it("offers leaf then parent candidates for a nested identity", () => {
    expect(noteFileCandidates("projects/ideas")).toEqual([
      "projects/ideas.md",
      "projects/ideas/_index.md",
    ]);
  });

  it("normalizes slashes and the .md extension out of the identity", () => {
    expect(normalizeNotePath("/projects/ideas.md/")).toBe("projects/ideas");
  });
});

describe("readNote", () => {
  it("reads a leaf note's Markdown by identity", async () => {
    const engine = fakeEngine({ "notes.md": "# Notes\n" });

    expect(await readNote(engine, "notes")).toEqual({
      path: "notes",
      file: "notes.md",
      markdown: "# Notes\n",
    });
  });

  it("resolves a parent note to its _index.md", async () => {
    const engine = fakeEngine({ "projects/_index.md": "# Projects\n" });

    expect(await readNote(engine, "projects")).toEqual({
      path: "projects",
      file: "projects/_index.md",
      markdown: "# Projects\n",
    });
  });

  it("reads the root note from the repo-root _index.md", async () => {
    const engine = fakeEngine({ "_index.md": "# Home\n" });

    expect(await readNote(engine, "")).toMatchObject({
      path: "",
      file: "_index.md",
    });
  });

  it("resolves to null when the note is missing", async () => {
    const engine = fakeEngine({ "_index.md": "# Home\n" });
    expect(await readNote(engine, "ghost")).toBeNull();
  });
});
