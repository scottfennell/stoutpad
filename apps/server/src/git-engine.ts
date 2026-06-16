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
  canonicalizeMarkdown,
  resolveWriteTarget,
  wipBranchName,
  type AttachmentGitEngine,
  type MutatingGitEngine,
  type NoteFile,
  type NoteMutation,
  type WipGitEngine,
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

/**
 * {@link WipGitEngine} backed by a Git working clone on the local filesystem.
 *
 * On top of commit-on-save (`writeNoteFile` → `main`) it implements the
 * ephemeral wip-branch lifecycle the autosave state machine drives:
 * {@link commitToWip} appends an autosave commit to `wip/<note>` (created from
 * `main` on the first commit of a session), {@link squashMergeWipToMain} folds
 * the whole session onto `main` as one commit, and {@link deleteWip} removes the
 * branch. It also applies tree mutations (create / rename / move, including the
 * leaf↔parent transition) atomically via {@link applyNoteMutation}, and stores
 * uploaded binary attachments under `assets/` via {@link writeAttachmentFile}.
 * Wip branches are local-only — nothing here pushes, so they are never published.
 * Every method restores the clone to a clean `main` checkout, so the working
 * tree the read/commit-on-save paths see is always `main`.
 */
export class NodeGitEngine implements WipGitEngine, MutatingGitEngine, AttachmentGitEngine {
  constructor(protected readonly cloneDir: string) {}

  async listNoteFiles(): Promise<NoteFile[]> {
    const { stdout } = await this.git(["ls-files", "-z"]);
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
    await this.git(["add", "--", path]);
    // Skip the commit when nothing changed, so a no-op save never errors on an
    // empty commit (commit-on-save is idempotent at the git level too).
    if (await this.isClean(path)) return;
    await this.git(["commit", "-m", message, "--", path]);
  }

  /**
   * Write one binary attachment near `desiredPath` (repo-relative POSIX, e.g.
   * `assets/diagram.png`) and commit it to `main`, returning the **final** path
   * actually used.
   *
   * Implements the {@link AttachmentGitEngine} seam: ensures the clone is on a
   * clean `main`, resolves a unique name (appending `-1`, `-2`, … before the
   * extension when the desired path is taken) so an upload never clobbers an
   * existing attachment, writes the raw bytes, and commits. Path-escape-guarded
   * like every other write.
   */
  async writeAttachmentFile(
    desiredPath: string,
    bytes: Uint8Array,
    message: string,
  ): Promise<string> {
    await this.checkoutMain();
    const path = await this.uniqueAttachmentPath(desiredPath);
    const full = this.safePath(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes);
    await this.git(["add", "--", path]);
    await this.git(["commit", "-m", message, "--", path]);
    return path;
  }

  /**
   * Resolve a repo-relative attachment path that is not already taken on disk,
   * appending a `-1`, `-2`, … suffix before the extension until one is free.
   */
  private async uniqueAttachmentPath(desiredPath: string): Promise<string> {
    if (this.resolveInClone(desiredPath) === null) {
      throw new Error(`refusing to write outside the working clone: ${desiredPath}`);
    }
    if (!(await exists(this.resolveInClone(desiredPath) as string))) return desiredPath;

    const dot = desiredPath.lastIndexOf(".");
    const stem = dot === -1 ? desiredPath : desiredPath.slice(0, dot);
    const ext = dot === -1 ? "" : desiredPath.slice(dot);
    for (let n = 1; ; n += 1) {
      const candidate = `${stem}-${n}${ext}`;
      const full = this.resolveInClone(candidate);
      if (full !== null && !(await exists(full))) return candidate;
    }
  }

  /**
   * Apply a tree mutation (create / rename / move, including a leaf↔parent
   * promotion or collapse) as **one atomic commit** on `main`.
   *
   * Runs the plan's directory/file `moves` (`git mv`, mkdir-ing destinations as
   * needed), then `creates` (write + `git add`), then `removes` (`git rm`), and
   * commits once with the plan's message — skipping the commit when the mutation
   * is a no-op. Every path is escape-guarded against leaving the clone. On any
   * error the working tree is reset so a half-applied mutation never lands
   * (all-or-nothing). Operates on `main`; nothing here pushes.
   */
  async applyNoteMutation(mutation: NoteMutation): Promise<void> {
    try {
      await this.checkoutMain();
      for (const move of mutation.moves) {
        this.safePath(move.from);
        const to = this.safePath(move.to);
        await mkdir(dirname(to), { recursive: true });
        await this.git(["mv", move.from, move.to]);
      }
      for (const create of mutation.creates) {
        const full = this.safePath(create.path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, create.content, "utf8");
        await this.git(["add", "--", create.path]);
      }
      for (const remove of mutation.removes) {
        this.safePath(remove);
        await this.git(["rm", "--", remove]);
      }
      if (await this.isClean()) return;
      await this.git(["commit", "-m", mutation.message]);
    } catch (err) {
      // Roll back any partial, uncommitted mutation so it is all-or-nothing.
      await this.git(["reset", "--hard", "HEAD"]).catch(() => undefined);
      await this.git(["clean", "-fd"]).catch(() => undefined);
      throw err;
    }
  }

  /** Ref name of the note's wip branch (see core `wipBranchName`). */
  wipBranchName(notePath: string): string {
    return wipBranchName(notePath);
  }

  /**
   * Commit `markdown` onto the note's `wip/<note>` branch, creating it from
   * `main` on the first commit of a session and appending to it thereafter. The
   * Markdown is canonicalized (idempotently — the state machine already sends
   * canonical content) and written to the note's stable backing file (resolved
   * against `main`). A commit that changes nothing is skipped, so no empty wip
   * commit is created. The clone is always returned to a clean `main` checkout.
   */
  async commitToWip(notePath: string, markdown: string): Promise<void> {
    const file = await resolveWriteTarget(this, notePath);
    const full = this.resolveInClone(file);
    if (full === null) {
      throw new Error(`refusing to write outside the working clone: ${file}`);
    }
    const canonical = canonicalizeMarkdown(markdown);
    const branch = wipBranchName(notePath);
    try {
      await this.checkoutWip(branch);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, canonical, "utf8");
      await this.git(["add", "--", file]);
      if (!(await this.isClean(file))) {
        await this.git(["commit", "-m", `Autosave ${file}`, "--", file]);
      }
    } finally {
      await this.checkoutMain();
    }
  }

  /**
   * Squash-merge the note's wip branch into `main` as a single commit with
   * `message`. A no-op when the branch does not exist or holds no net change vs
   * `main` (no empty commit). Produces a plain commit (not a merge commit), so
   * `main` stays linear — one commit per editing session.
   */
  async squashMergeWipToMain(notePath: string, message: string): Promise<void> {
    const branch = wipBranchName(notePath);
    if (!(await this.branchExists(branch))) return;
    await this.checkoutMain();
    await this.git(["merge", "--squash", branch]);
    if (await this.isClean()) return;
    await this.git(["commit", "-m", message]);
  }

  /** Delete the note's wip branch (idempotent if it does not exist). */
  async deleteWip(notePath: string): Promise<void> {
    const branch = wipBranchName(notePath);
    if (!(await this.branchExists(branch))) return;
    if ((await this.currentBranch()) === branch) {
      await this.checkoutMain();
    }
    await this.git(["branch", "-D", branch]);
  }

  /** Run a `git` subcommand in the working clone. */
  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return run("git", ["-C", this.cloneDir, ...args]);
  }

  /** Whether the working tree is clean (optionally scoped to one `path`). */
  private async isClean(path?: string): Promise<boolean> {
    const args = ["status", "--porcelain"];
    if (path !== undefined) args.push("--", path);
    const { stdout } = await this.git(args);
    return stdout.trim() === "";
  }

  /** Check out the wip branch, creating it from `main` when it does not exist. */
  private async checkoutWip(branch: string): Promise<void> {
    if (await this.branchExists(branch)) {
      await this.git(["checkout", branch]);
    } else {
      await this.git(["checkout", "-b", branch, "main"]);
    }
  }

  /**
   * Force the clone back onto a clean `main`. Used after every wip operation so
   * the shared working tree is a stable `main` baseline for the next request;
   * the force also recovers from a half-applied squash on an error path (it only
   * discards uncommitted working-tree state, never commits).
   */
  private async checkoutMain(): Promise<void> {
    await this.git(["checkout", "-f", "main"]);
  }

  /** Whether a local branch ref exists. */
  private async branchExists(branch: string): Promise<boolean> {
    try {
      await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Name of the branch currently checked out in the clone. */
  private async currentBranch(): Promise<string> {
    const { stdout } = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    return stdout.trim();
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

  /**
   * Like {@link resolveInClone} but throws on an escape — used by the write/
   * mutation paths where a crafted path must hard-fail rather than be skipped.
   */
  private safePath(path: string): string {
    const full = this.resolveInClone(path);
    if (full === null) {
      throw new Error(`refusing to touch a path outside the working clone: ${path}`);
    }
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
