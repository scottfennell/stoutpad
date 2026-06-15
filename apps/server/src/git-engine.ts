/**
 * Node Git engine: the runtime side of `core/git-engine`.
 *
 * This is the only place that touches the filesystem and the `git` binary. It
 * (1) initializes the on-disk storage on first boot — a **bare repo** (the
 * canonical store / future Git remote) plus a **working clone** seeded with a
 * starter `_index.md` — and (2) implements the {@link WritableGitEngine} seam by
 * listing the Markdown files tracked in the working clone, reading a single note
 * file's content, and writing + committing an edited note to `main` (all
 * guarded against path escapes).
 *
 * We shell out to the system `git` rather than pulling in a Git library: local
 * bare/clone/commit/push are first-class in the CLI and add zero dependencies.
 * Because the read contract lives in `@stout/core`, swapping in
 * `isomorphic-git` (e.g. for the browser FS backend) later is a backend swap
 * behind the same interface. See
 * `docs/adr/0001-note-tree-identity-and-git-storage.md`.
 */

import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  INDEX_FILE,
  type NoteFile,
  type WritableGitEngine,
} from "@stout/core";

const run = promisify(execFile);

/** On-disk layout for the workspace repository. */
export interface RepoPaths {
  /** Absolute path to the bare repo (canonical store / Git remote). */
  bareDir: string;
  /** Absolute path to the working clone the server reads and edits. */
  cloneDir: string;
}

/** Default storage directory; overridable via `STOUT_DATA_DIR`. */
export function loadRepoPaths(env = process.env): RepoPaths {
  const dataDir = env.STOUT_DATA_DIR ?? "data";
  return {
    bareDir: join(dataDir, "repo.git"),
    cloneDir: join(dataDir, "clone"),
  };
}

const STARTER_NOTE = `# Welcome to Stout

This is your first note. Stout stores every note as a plain Markdown file in a
Git repository you control.

Notes form a single hierarchy: a note that has children is just a folder that
also contains an \`_index.md\`. Start writing, or create child notes to organize
your thinking.
`;

/**
 * Ensure the workspace repo exists, initializing it on first boot.
 *
 * Idempotent: if the working clone is already present this is a no-op, so it is
 * safe to call on every startup.
 */
export async function ensureWorkspaceRepo(paths: RepoPaths): Promise<void> {
  if (await exists(join(paths.cloneDir, ".git"))) return;

  await mkdir(dirname(paths.bareDir), { recursive: true });

  if (!(await exists(paths.bareDir))) {
    await run("git", ["init", "--bare", "-b", "main", paths.bareDir]);
  }

  await run("git", ["clone", paths.bareDir, paths.cloneDir]);
  // Local identity so committing never depends on global git config.
  await run("git", ["-C", paths.cloneDir, "config", "user.email", "stout@localhost"]);
  await run("git", ["-C", paths.cloneDir, "config", "user.name", "Stout"]);

  await writeFile(join(paths.cloneDir, INDEX_FILE), STARTER_NOTE, "utf8");
  await run("git", ["-C", paths.cloneDir, "add", "-A"]);
  await run("git", ["-C", paths.cloneDir, "commit", "-m", "Seed starter note"]);
  // Publish to the bare repo so the canonical store holds the starter note too.
  await run("git", ["-C", paths.cloneDir, "push", "-u", "origin", "main"]);
}

/** {@link WritableGitEngine} backed by a Git working clone on the local filesystem. */
export class NodeGitEngine implements WritableGitEngine {
  constructor(private readonly cloneDir: string) {}

  async listNoteFiles(): Promise<NoteFile[]> {
    const { stdout } = await run("git", ["-C", this.cloneDir, "ls-files", "-z"]);
    return stdout
      .split("\0")
      .filter((path) => path.length > 0 && path.toLowerCase().endsWith(".md"))
      .map((path) => ({ path }));
  }

  async readNoteFile(path: string): Promise<string | null> {
    const full = this.resolveInClone(path);
    if (full === null) return null;
    try {
      return await readFile(full, "utf8");
    } catch {
      return null;
    }
  }

  async writeNoteFile(path: string, content: string, message: string): Promise<void> {
    const full = this.resolveInClone(path);
    if (full === null) {
      throw new Error(`refusing to write outside the working clone: ${path}`);
    }
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
    await run("git", ["-C", this.cloneDir, "add", "--", path]);
    // Skip the commit when nothing changed, so a no-op save never errors on an
    // empty commit (commit-on-save is idempotent at the git level too).
    const { stdout } = await run("git", [
      "-C",
      this.cloneDir,
      "status",
      "--porcelain",
      "--",
      path,
    ]);
    if (stdout.trim() === "") return;
    await run("git", ["-C", this.cloneDir, "commit", "-m", message, "--", path]);
  }

  /**
   * Resolve a repo-relative path under the clone root, rejecting anything that
   * escapes it, so a crafted `path` can never read or write outside the clone.
   * Returns `null` when the path escapes (reads treat that as "missing").
   */
  private resolveInClone(path: string): string | null {
    const root = resolve(this.cloneDir);
    const full = resolve(root, path);
    if (full !== root && !full.startsWith(root + sep)) return null;
    return full;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
