import { execFile } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readNote, readNoteTree } from "@stout/core";
import {
  ensureWorkspaceRepo,
  loadRepoPaths,
  NodeGitEngine,
  type RepoPaths,
} from "./git-engine.js";

const run = promisify(execFile);

let dataDir: string;
let paths: RepoPaths;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "stout-repo-"));
  paths = {
    bareDir: join(dataDir, "repo.git"),
    cloneDir: join(dataDir, "clone"),
  };
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** Commit a new file into the working clone, simulating a later note write. */
async function commitNote(
  cloneDir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const full = join(cloneDir, relativePath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf8");
  await run("git", ["-C", cloneDir, "add", "-A"]);
  await run("git", ["-C", cloneDir, "commit", "-m", `add ${relativePath}`]);
}

describe("ensureWorkspaceRepo", () => {
  it("initializes a bare repo + working clone seeded with a starter note", async () => {
    await ensureWorkspaceRepo(paths);

    // Bare repo exists and the starter note is committed in it.
    const { stdout } = await run("git", [
      "-C",
      paths.bareDir,
      "ls-tree",
      "--name-only",
      "main",
    ]);
    expect(stdout.split("\n")).toContain("_index.md");

    // Working clone has the starter note tracked.
    const engine = new NodeGitEngine(paths.cloneDir);
    expect(await engine.listNoteFiles()).toEqual([{ path: "_index.md" }]);
  });

  it("is idempotent across reboots", async () => {
    await ensureWorkspaceRepo(paths);
    await commitNote(paths.cloneDir, "notes.md", "# Notes\n");

    // A second call must not re-clone or clobber existing content.
    await ensureWorkspaceRepo(paths);

    const engine = new NodeGitEngine(paths.cloneDir);
    const files = (await engine.listNoteFiles()).map((f) => f.path).sort();
    expect(files).toEqual(["_index.md", "notes.md"]);
  });
});

describe("NodeGitEngine + readNoteTree", () => {
  it("reads a seeded clone into the unified note tree", async () => {
    await ensureWorkspaceRepo(paths);
    const engine = new NodeGitEngine(paths.cloneDir);

    const { root } = await readNoteTree(engine);
    expect(root).toMatchObject({
      path: "",
      title: "Home",
      file: "_index.md",
      kind: "parent",
      children: [],
    });
  });

  it("maps parent and leaf notes from the real repo", async () => {
    await ensureWorkspaceRepo(paths);
    await commitNote(paths.cloneDir, "projects/_index.md", "# Projects\n");
    await commitNote(paths.cloneDir, "projects/ideas.md", "# Ideas\n");

    const engine = new NodeGitEngine(paths.cloneDir);
    const { root } = await readNoteTree(engine);

    const projects = root.children.find((c) => c.path === "projects");
    expect(projects).toMatchObject({
      title: "Projects",
      file: "projects/_index.md",
      kind: "parent",
    });
    expect(projects?.children).toEqual([
      {
        path: "projects/ideas",
        title: "Ideas",
        file: "projects/ideas.md",
        kind: "leaf",
        children: [],
      },
    ]);
  });
});

describe("NodeGitEngine.readNoteFile + readNote", () => {
  it("reads the starter root note's Markdown by identity", async () => {
    await ensureWorkspaceRepo(paths);
    const engine = new NodeGitEngine(paths.cloneDir);

    const note = await readNote(engine, "");
    expect(note).toMatchObject({ path: "", file: "_index.md" });
    expect(note?.markdown).toContain("# Welcome to Stout");
  });

  it("reads a leaf and a parent note from the real repo", async () => {
    await ensureWorkspaceRepo(paths);
    await commitNote(paths.cloneDir, "projects/_index.md", "# Projects\n");
    await commitNote(
      paths.cloneDir,
      "projects/ideas.md",
      "# Ideas\n\n- [ ] Ship it\n",
    );
    const engine = new NodeGitEngine(paths.cloneDir);

    expect(await readNote(engine, "projects")).toMatchObject({
      path: "projects",
      file: "projects/_index.md",
      markdown: "# Projects\n",
    });
    expect((await readNote(engine, "projects/ideas"))?.markdown).toContain(
      "- [ ] Ship it",
    );
  });

  it("resolves to null for a missing note", async () => {
    await ensureWorkspaceRepo(paths);
    const engine = new NodeGitEngine(paths.cloneDir);
    expect(await readNote(engine, "does/not/exist")).toBeNull();
  });

  it("refuses to read outside the working clone", async () => {
    await ensureWorkspaceRepo(paths);
    const engine = new NodeGitEngine(paths.cloneDir);
    expect(await engine.readNoteFile("../../etc/passwd")).toBeNull();
  });
});

describe("loadRepoPaths", () => {
  it("derives bare + clone paths under STOUT_DATA_DIR", () => {
    expect(loadRepoPaths({ STOUT_DATA_DIR: "/data" })).toEqual({
      bareDir: join("/data", "repo.git"),
      cloneDir: join("/data", "clone"),
    });
  });

  it("defaults to a local data directory", () => {
    expect(loadRepoPaths({})).toEqual({
      bareDir: join("data", "repo.git"),
      cloneDir: join("data", "clone"),
    });
  });
});
