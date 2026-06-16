/**
 * Pure path/listing helpers for the browser Git backend.
 *
 * The browser stores the note repo in an IndexedDB-backed filesystem
 * (`@isomorphic-git/lightning-fs`) under a fixed working directory, and drives it
 * with `isomorphic-git`. None of that IO lives here — this module is the pure,
 * runtime-agnostic string maths the backend needs: the workspace constants, the
 * repo-path safety guard (mirroring the Node engine's escape guard), the
 * absolute-path join, the ancestor directories to create, and the
 * tracked-file-list → {@link NoteFile} mapping. Keeping it pure means it is unit
 * tested with no real IndexedDB, while {@link BrowserGitEngine} (in
 * `browser-git-engine.ts`) wires these to the actual filesystem.
 *
 * See `docs/adr/0011-pwa-offline-and-conflict-policy.md`.
 */

import type { NoteFile } from "@stout/core";

/** The lightning-fs working directory the note repo is cloned/initialized into. */
export const BROWSER_WORKDIR = "/stout" as const;

/** The IndexedDB store name backing the browser filesystem. */
export const BROWSER_FS_NAME = "stout-fs" as const;

/**
 * Whether `path` is a safe repo-relative POSIX file path: non-empty, not
 * absolute, and free of `.`/`..`/empty segments (so it can never escape the
 * working directory). The browser counterpart to the Node engine's
 * `resolveInClone` guard.
 */
export function isSafeRepoPath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Join the working directory and a (guarded) repo-relative path into the absolute
 * path used against the filesystem. Throws on an unsafe path so a crafted path
 * hard-fails rather than escaping the repo.
 */
export function repoFilePath(workdir: string, path: string): string {
  if (!isSafeRepoPath(path)) {
    throw new Error(`refusing to touch a path outside the repo: ${path}`);
  }
  return `${workdir}/${path}`;
}

/**
 * The absolute ancestor directories of a repo-relative file, deepest last, that
 * must exist before the file can be written (lightning-fs `mkdir` is not
 * recursive). `_index.md` has none; `projects/ideas.md` yields `<workdir>/projects`.
 */
export function ancestorDirs(workdir: string, path: string): string[] {
  const segments = path.split("/").slice(0, -1);
  const dirs: string[] = [];
  let current = workdir;
  for (const segment of segments) {
    current = `${current}/${segment}`;
    dirs.push(current);
  }
  return dirs;
}

/**
 * Map a Git tracked-file list into the {@link NoteFile} set the core tree mapper
 * consumes: keep only safe `.md` paths, sorted for determinism. Mirrors the Node
 * engine's `listNoteFiles` filtering.
 */
export function toNoteFiles(paths: readonly string[]): NoteFile[] {
  return paths
    .filter((path) => path.toLowerCase().endsWith(".md") && isSafeRepoPath(path))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((path) => ({ path }));
}
