import { describe, expect, it } from "vitest";
import {
  BROWSER_FS_NAME,
  BROWSER_WORKDIR,
  ancestorDirs,
  isSafeRepoPath,
  repoFilePath,
  toNoteFiles,
} from "./browser-fs.js";

describe("isSafeRepoPath", () => {
  it("accepts plain repo-relative POSIX file paths", () => {
    expect(isSafeRepoPath("_index.md")).toBe(true);
    expect(isSafeRepoPath("projects/ideas.md")).toBe(true);
    expect(isSafeRepoPath("a/b/c/deep.md")).toBe(true);
  });

  it("rejects empty, absolute, escaping, or malformed paths", () => {
    expect(isSafeRepoPath("")).toBe(false);
    expect(isSafeRepoPath("/etc/passwd")).toBe(false);
    expect(isSafeRepoPath("../secret.md")).toBe(false);
    expect(isSafeRepoPath("projects/../../escape.md")).toBe(false);
    expect(isSafeRepoPath("projects/./ideas.md")).toBe(false);
    expect(isSafeRepoPath("projects//ideas.md")).toBe(false);
    expect(isSafeRepoPath("projects/ideas.md/")).toBe(false);
    expect(isSafeRepoPath("a\\b.md")).toBe(false);
  });
});

describe("repoFilePath", () => {
  it("joins the workdir with a safe path", () => {
    expect(repoFilePath(BROWSER_WORKDIR, "projects/ideas.md")).toBe(
      "/stout/projects/ideas.md",
    );
  });

  it("throws on an unsafe path rather than escaping the repo", () => {
    expect(() => repoFilePath(BROWSER_WORKDIR, "../escape.md")).toThrow(/outside the repo/);
  });
});

describe("ancestorDirs", () => {
  it("returns no directories for a top-level file", () => {
    expect(ancestorDirs(BROWSER_WORKDIR, "_index.md")).toEqual([]);
  });

  it("returns each nested directory, deepest last", () => {
    expect(ancestorDirs(BROWSER_WORKDIR, "a/b/c.md")).toEqual(["/stout/a", "/stout/a/b"]);
  });
});

describe("toNoteFiles", () => {
  it("keeps only safe markdown files, sorted, as NoteFiles", () => {
    expect(
      toNoteFiles(["projects/ideas.md", "_index.md", "assets/logo.png", "../x.md"]),
    ).toEqual([{ path: "_index.md" }, { path: "projects/ideas.md" }]);
  });

  it("matches the .md extension case-insensitively", () => {
    expect(toNoteFiles(["Notes.MD"])).toEqual([{ path: "Notes.MD" }]);
  });
});

describe("constants", () => {
  it("pin the workspace directory and IndexedDB store name", () => {
    expect(BROWSER_WORKDIR).toBe("/stout");
    expect(BROWSER_FS_NAME).toBe("stout-fs");
  });
});
