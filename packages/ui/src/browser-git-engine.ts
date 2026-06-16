/**
 * Browser Git engine: the IndexedDB-backed runtime side of `core/git-engine`.
 *
 * This is the browser counterpart to the server's `NodeGitEngine`. Where that
 * shells out to the `git` binary against a working clone on disk, this drives
 * `isomorphic-git` against an `@isomorphic-git/lightning-fs` filesystem persisted
 * in IndexedDB — so a PWA can read and commit notes entirely offline, with no
 * server. It implements the **same** {@link WritableGitEngine} seam (list / read /
 * write-and-commit), which is exactly what the offline editor and the
 * `core/conflict` `applyConflictResolution` policy consume, so swapping this in
 * for the HTTP backend is a backend swap behind one interface.
 *
 * The pure path maths (safety guard, joins, ancestor dirs, the tracked-file →
 * {@link NoteFile} mapping) lives in `browser-fs.ts` and is unit tested; this
 * module is the thin IO wiring over the two libraries and is exercised in a real
 * browser (it needs IndexedDB), not in the offline unit suite.
 *
 * See `docs/adr/0011-pwa-offline-and-conflict-policy.md`.
 */

import FS from "@isomorphic-git/lightning-fs";
import git from "isomorphic-git";
import { INDEX_FILE, type NoteFile, type WritableGitEngine } from "@stout/core";
import {
  BROWSER_FS_NAME,
  BROWSER_WORKDIR,
  ancestorDirs,
  isSafeRepoPath,
  repoFilePath,
  toNoteFiles,
} from "./browser-fs.js";

/** Commit identity for browser-made commits (matches the server's local identity). */
const AUTHOR = { name: "Stout", email: "stout@localhost" };

/** The starter note seeded into a brand-new browser repo (mirrors the server's). */
const STARTER_NOTE = `# Welcome to Stout

This is your first note. Stout stores every note as a plain Markdown file in a
Git repository — here, one that lives in your browser and works offline.

Notes form a single hierarchy: a note that has children is just a folder that
also contains an \`_index.md\`. Start writing, or create child notes to organize
your thinking.
`;

/**
 * A {@link WritableGitEngine} backed by `isomorphic-git` over an IndexedDB
 * filesystem. Commit-on-save semantics match the Node engine: list the `.md`
 * files tracked at `HEAD`, read a single note (path-escape-guarded), and write +
 * commit an edited note — skipping the commit when nothing changed so there is no
 * empty commit.
 */
export class BrowserGitEngine implements WritableGitEngine {
  private readonly fs: FS;
  private readonly dir: string;

  constructor(fs: FS = new FS(BROWSER_FS_NAME), dir: string = BROWSER_WORKDIR) {
    this.fs = fs;
    this.dir = dir;
  }

  async listNoteFiles(): Promise<NoteFile[]> {
    try {
      const files = await git.listFiles({ fs: this.fs, dir: this.dir, ref: "HEAD" });
      return toNoteFiles(files);
    } catch {
      // No commits yet (no HEAD) → an empty repo lists no notes.
      return [];
    }
  }

  async readNoteFile(path: string): Promise<string | null> {
    if (!isSafeRepoPath(path)) return null;
    try {
      return await this.fs.promises.readFile(repoFilePath(this.dir, path), "utf8");
    } catch {
      return null;
    }
  }

  async writeNoteFile(path: string, content: string, message: string): Promise<void> {
    if (!isSafeRepoPath(path)) {
      throw new Error(`refusing to write outside the repo: ${path}`);
    }
    // Skip a no-op write so commit-on-save never produces an empty commit.
    if ((await this.readNoteFile(path)) === content) return;
    await this.ensureDirs(path);
    await this.fs.promises.writeFile(repoFilePath(this.dir, path), content, "utf8");
    await git.add({ fs: this.fs, dir: this.dir, filepath: path });
    await git.commit({ fs: this.fs, dir: this.dir, message, author: AUTHOR });
  }

  /** Create each ancestor directory of `path` (lightning-fs `mkdir` is not recursive). */
  private async ensureDirs(path: string): Promise<void> {
    for (const dir of ancestorDirs(this.dir, path)) {
      await this.fs.promises.mkdir(dir).catch(() => undefined); // ignore "already exists"
    }
  }
}

/**
 * Ensure a browser repo exists, initializing and seeding it on first run.
 *
 * Idempotent: if the repo already has a commit (`HEAD` resolves) this is a no-op,
 * so it is safe to call on every app start. Otherwise it `git init`s the
 * lightning-fs working directory on `main` and commits the {@link STARTER_NOTE},
 * mirroring the server's `ensureWorkspaceRepo`.
 */
export async function ensureBrowserRepo(
  fs: FS = new FS(BROWSER_FS_NAME),
  dir: string = BROWSER_WORKDIR,
): Promise<void> {
  try {
    await git.resolveRef({ fs, dir, ref: "HEAD" });
    return; // already initialized with at least one commit
  } catch {
    // Not initialized yet — fall through and seed it.
  }
  await fs.promises.mkdir(dir).catch(() => undefined);
  await git.init({ fs, dir, defaultBranch: "main" });
  await fs.promises.writeFile(`${dir}/${INDEX_FILE}`, STARTER_NOTE, "utf8");
  await git.add({ fs, dir, filepath: INDEX_FILE });
  await git.commit({ fs, dir, message: "Seed starter note", author: AUTHOR });
}
