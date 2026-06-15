import { execFile } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNote, moveNote, readNote, readNoteTree, renameNote, writeNote } from "@stout/core";
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

describe("NodeGitEngine.writeNoteFile + writeNote", () => {
  it("writes an edited note, commits it to main, and shows in git log", async () => {
    await ensureWorkspaceRepo(paths);
    const engine = new NodeGitEngine(paths.cloneDir);

    const saved = await writeNote(engine, "", "# Home\n\nEdited **bold**.\n");
    expect(saved).toMatchObject({ path: "", file: "_index.md" });

    // The committed working-clone file holds the canonical Markdown; a reload
    // (readNote) shows the persisted content.
    expect((await readNote(engine, ""))?.markdown).toBe(
      "# Home\n\nEdited **bold**.\n",
    );

    // git log shows the commit on main.
    const { stdout } = await run("git", [
      "-C",
      paths.cloneDir,
      "log",
      "--oneline",
      "main",
    ]);
    expect(stdout).toContain("Edit _index.md");
  });

  it("canonicalizes loose Markdown before committing it", async () => {
    await ensureWorkspaceRepo(paths);
    const engine = new NodeGitEngine(paths.cloneDir);

    await writeNote(engine, "", "#  Home\n\n*  one\n+  two\n");

    expect((await readNote(engine, ""))?.markdown).toBe(
      "# Home\n\n- one\n- two\n",
    );
  });

  it("creates a new leaf note's file and tracks it", async () => {
    await ensureWorkspaceRepo(paths);
    const engine = new NodeGitEngine(paths.cloneDir);

    await writeNote(engine, "fresh", "# Fresh\n\n- [ ] todo\n");

    const files = (await engine.listNoteFiles()).map((f) => f.path).sort();
    expect(files).toEqual(["_index.md", "fresh.md"]);
    expect((await readNote(engine, "fresh"))?.markdown).toBe(
      "# Fresh\n\n- [ ] todo\n",
    );
  });

  it("does not create an empty commit when content is unchanged", async () => {
    await ensureWorkspaceRepo(paths);
    const engine = new NodeGitEngine(paths.cloneDir);
    const head = async (): Promise<string> =>
      (
        await run("git", ["-C", paths.cloneDir, "rev-parse", "HEAD"])
      ).stdout.trim();

    const before = await head();
    // Re-writing the starter note's exact current bytes is a no-op.
    const current = (await readNote(engine, ""))!.markdown;
    await engine.writeNoteFile("_index.md", current, "no-op");

    expect(await head()).toBe(before);
  });

  it("refuses to write outside the working clone", async () => {
    await ensureWorkspaceRepo(paths);
    const engine = new NodeGitEngine(paths.cloneDir);

    await expect(
      engine.writeNoteFile("../escape.md", "x", "nope"),
    ).rejects.toThrow(/outside the working clone/u);
  });
});

describe("NodeGitEngine wip-branch lifecycle (autosave + squash)", () => {
  async function branchExists(dir: string, branch: string): Promise<boolean> {
    try {
      await run("git", [
        "-C",
        dir,
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /** Commit subjects on a ref, newest first. */
  async function subjects(dir: string, ref: string): Promise<string[]> {
    const { stdout } = await run("git", ["-C", dir, "log", "--format=%s", ref]);
    return stdout.split("\n").filter((line) => line.length > 0);
  }

  async function currentBranch(dir: string): Promise<string> {
    const { stdout } = await run("git", [
      "-C",
      dir,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    return stdout.trim();
  }

  it("autosaves onto wip/<note>, leaving main and the working tree on main", async () => {
    await ensureWorkspaceRepo(paths);
    const engine = new NodeGitEngine(paths.cloneDir);

    await engine.commitToWip("notes", "# Notes\n\nDraft\n");

    // The wip branch exists and carries the autosave commit...
    expect(await branchExists(paths.cloneDir, "wip/notes")).toBe(true);
    expect(await subjects(paths.cloneDir, "wip/notes")).toContain("Autosave notes.md");
    const { stdout: wipFile } = await run("git", [
      "-C",
      paths.cloneDir,
      "show",
      "wip/notes:notes.md",
    ]);
    expect(wipFile).toBe("# Notes\n\nDraft\n");

    // ...but main is untouched: the clone is back on main, where the note does
    // not exist yet (it lives only on the wip branch).
    expect(await currentBranch(paths.cloneDir)).toBe("main");
    expect(await readNote(engine, "notes")).toBeNull();
  });

  it("appends each autosave to the same wip branch", async () => {
    await ensureWorkspaceRepo(paths);
    const engine = new NodeGitEngine(paths.cloneDir);

    await engine.commitToWip("notes", "# Notes\n\nA\n");
    await engine.commitToWip("notes", "# Notes\n\nA\n\nB\n");

    const autosaves = (await subjects(paths.cloneDir, "wip/notes")).filter(
      (subject) => subject === "Autosave notes.md",
    );
    expect(autosaves).toHaveLength(2);
  });

  it("skips an empty wip commit when the content is unchanged", async () => {
    await ensureWorkspaceRepo(paths);
    const engine = new NodeGitEngine(paths.cloneDir);
    // Put canonical content on main first, then autosave the identical content.
    await writeNote(engine, "notes", "# Notes\n\nHi\n");

    await engine.commitToWip("notes", "# Notes\n\nHi\n");

    // The branch was created at main but no commit was added on top of it.
    const { stdout: wipRev } = await run("git", [
      "-C",
      paths.cloneDir,
      "rev-parse",
      "wip/notes",
    ]);
    const { stdout: mainRev } = await run("git", [
      "-C",
      paths.cloneDir,
      "rev-parse",
      "main",
    ]);
    expect(wipRev.trim()).toBe(mainRev.trim());
  });

  it("squash-merges a session into one main commit and deletes the wip branch", async () => {
    await ensureWorkspaceRepo(paths);
    const engine = new NodeGitEngine(paths.cloneDir);
    const mainBefore = (await subjects(paths.cloneDir, "main")).length;

    for (const body of ["A", "A\n\nB", "A\n\nB\n\nC"]) {
      await engine.commitToWip("notes", `# Notes\n\n${body}\n`);
    }
    await engine.squashMergeWipToMain("notes", "Edit notes");
    await engine.deleteWip("notes");

    // Exactly one new commit on main despite three wip autosaves.
    const mainSubjects = await subjects(paths.cloneDir, "main");
    expect(mainSubjects.length).toBe(mainBefore + 1);
    expect(mainSubjects[0]).toBe("Edit notes");
    // The squashed content landed on main and the wip branch is gone.
    expect((await readNote(engine, "notes"))?.markdown).toBe("# Notes\n\nA\n\nB\n\nC\n");
    expect(await branchExists(paths.cloneDir, "wip/notes")).toBe(false);

    // It is a plain commit (a single parent), not a merge commit, so main stays
    // linear — one meaningful commit per editing session.
    const { stdout: parents } = await run("git", [
      "-C",
      paths.cloneDir,
      "rev-list",
      "--parents",
      "-n",
      "1",
      "HEAD",
    ]);
    expect(parents.trim().split(/\s+/u)).toHaveLength(2);
  });

  it("squashMergeWipToMain and deleteWip are no-ops without a wip branch", async () => {
    await ensureWorkspaceRepo(paths);
    const engine = new NodeGitEngine(paths.cloneDir);
    const before = (await subjects(paths.cloneDir, "main")).length;

    await engine.squashMergeWipToMain("ghost", "nothing to squash");
    await engine.deleteWip("ghost");

    expect((await subjects(paths.cloneDir, "main")).length).toBe(before);
  });

  it("never publishes a wip branch to the bare repo (never pushed)", async () => {
    await ensureWorkspaceRepo(paths);
    const engine = new NodeGitEngine(paths.cloneDir);

    await engine.commitToWip("notes", "# Notes\n\nP\n");
    // Mid-session the wip branch is local-only: the bare repo has no wip ref.
    const mid = await run("git", [
      "-C",
      paths.bareDir,
      "for-each-ref",
      "--format=%(refname)",
    ]);
    expect(mid.stdout).not.toContain("wip/");

    await engine.squashMergeWipToMain("notes", "Edit notes");
    await engine.deleteWip("notes");

    // After the session the bare repo still holds no wip ref anywhere.
    const after = await run("git", [
      "-C",
      paths.bareDir,
      "for-each-ref",
      "--format=%(refname)",
    ]);
    expect(after.stdout).not.toContain("wip/");
  });
});

describe("NodeGitEngine note mutations (create / rename / move)", () => {
  async function notePaths(dir: string): Promise<string[]> {
    const engine = new NodeGitEngine(dir);
    return (await engine.listNoteFiles()).map((f) => f.path).sort();
  }

  /** Commit subjects on a ref, newest first. */
  async function subjects(dir: string, ref: string): Promise<string[]> {
    const { stdout } = await run("git", ["-C", dir, "log", "--format=%s", ref]);
    return stdout.split("\n").filter((line) => line.length > 0);
  }

  it("creates a new leaf note and commits it to main", async () => {
    await ensureWorkspaceRepo(paths);
    const engine = new NodeGitEngine(paths.cloneDir);
    const before = (await subjects(paths.cloneDir, "main")).length;

    const res = await createNote(engine, "", "My Ideas");

    expect(res).toEqual({ path: "my-ideas", file: "my-ideas.md" });
    expect(await notePaths(paths.cloneDir)).toEqual(["_index.md", "my-ideas.md"]);
    expect((await readNote(engine, "my-ideas"))?.markdown).toBe("# My Ideas\n");
    const mainSubjects = await subjects(paths.cloneDir, "main");
    expect(mainSubjects.length).toBe(before + 1);
    expect(mainSubjects[0]).toBe("Create note my-ideas");
  });

  it("promotes a leaf parent to a directory on its first child (git mv)", async () => {
    await ensureWorkspaceRepo(paths);
    const engine = new NodeGitEngine(paths.cloneDir);
    await writeNote(engine, "projects", "# Projects\n\nMy work.\n");

    await createNote(engine, "projects", "First Idea");

    // `projects.md` became `projects/_index.md` (content preserved) and the new
    // child lives beside it; the parent keeps its `projects` identity.
    expect(await notePaths(paths.cloneDir)).toEqual([
      "_index.md",
      "projects/_index.md",
      "projects/first-idea.md",
    ]);
    expect((await readNote(engine, "projects"))?.markdown).toBe(
      "# Projects\n\nMy work.\n",
    );
    const { root } = await readNoteTree(engine);
    const projects = root.children.find((c) => c.path === "projects");
    expect(projects).toMatchObject({ kind: "parent", file: "projects/_index.md" });
    expect(projects?.children.map((c) => c.path)).toEqual(["projects/first-idea"]);
  });

  it("renames a parent note by moving its whole subtree as one commit", async () => {
    await ensureWorkspaceRepo(paths);
    await commitNote(paths.cloneDir, "projects/_index.md", "# Projects\n");
    await commitNote(paths.cloneDir, "projects/ideas.md", "# Ideas\n");
    await commitNote(paths.cloneDir, "projects/sub/_index.md", "# Sub\n");
    await commitNote(paths.cloneDir, "projects/sub/deep.md", "# Deep\n");
    const engine = new NodeGitEngine(paths.cloneDir);

    const res = await renameNote(engine, "projects", "Work");

    expect(res).toMatchObject({ path: "work", file: "work/_index.md" });
    expect(await notePaths(paths.cloneDir)).toEqual([
      "_index.md",
      "work/_index.md",
      "work/ideas.md",
      "work/sub/_index.md",
      "work/sub/deep.md",
    ]);
    expect((await readNote(engine, "work/sub/deep"))?.markdown).toBe("# Deep\n");
    // One commit on main for the whole subtree move.
    expect((await subjects(paths.cloneDir, "main"))[0]).toBe(
      "Rename note projects to work",
    );
  });

  it("moves a leaf under another parent, collapsing the emptied source parent", async () => {
    await ensureWorkspaceRepo(paths);
    await commitNote(paths.cloneDir, "a/_index.md", "# A\n");
    await commitNote(paths.cloneDir, "a/only.md", "# Only\n");
    await commitNote(paths.cloneDir, "b/_index.md", "# B\n");
    const engine = new NodeGitEngine(paths.cloneDir);

    const res = await moveNote(engine, "a/only", "b");

    expect(res).toEqual({ path: "b/only", file: "b/only.md" });
    // `only` moved under `b`; `a` lost its last child and collapsed to `a.md`.
    expect(await notePaths(paths.cloneDir)).toEqual([
      "_index.md",
      "a.md",
      "b/_index.md",
      "b/only.md",
    ]);
    expect((await readNote(engine, "a"))?.markdown).toBe("# A\n");
    expect((await readNote(engine, "b/only"))?.markdown).toBe("# Only\n");
  });

  it("rejects an invalid mutation (move into own subtree) without committing", async () => {
    await ensureWorkspaceRepo(paths);
    await commitNote(paths.cloneDir, "a/_index.md", "# A\n");
    await commitNote(paths.cloneDir, "a/b.md", "# B\n");
    const engine = new NodeGitEngine(paths.cloneDir);
    const before = (await subjects(paths.cloneDir, "main")).length;

    await expect(moveNote(engine, "a", "a/b")).rejects.toThrow(/subtree/u);
    expect((await subjects(paths.cloneDir, "main")).length).toBe(before);
  });

  it("never publishes a mutation's commit beyond the clone (no push)", async () => {
    await ensureWorkspaceRepo(paths);
    const engine = new NodeGitEngine(paths.cloneDir);

    await createNote(engine, "", "Solo");

    // The new note lives on the clone's main but was never pushed to the bare repo.
    const { stdout } = await run("git", [
      "-C",
      paths.bareDir,
      "ls-tree",
      "--name-only",
      "main",
    ]);
    expect(stdout.split("\n")).not.toContain("solo.md");
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
