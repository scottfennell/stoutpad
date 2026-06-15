/**
 * The note-content read contract.
 *
 * A note's **identity** is its tree `path` (see `core/note-tree`). To open a note
 * the HTTP layer resolves that identity to the Markdown file backing it and
 * returns the file's canonical Markdown. This module owns the pure pieces of that
 * contract — the REST path, the response shape, and the identity → backing-file
 * resolution — so the Node/Git read can stay a thin, injectable seam in
 * `apps/server`. The engine composition (`readNote`) lives alongside
 * {@link readNoteTree} in `core/git-engine`.
 */

import { INDEX_FILE } from "./note-tree.js";

/** REST path of the read-only single-note endpoint (`?path=<identity>`). */
export const NOTE_PATH = "/api/note" as const;

/** Response body of `GET /api/note`. */
export interface NoteContentResponse {
  /** Stable identity of the note (its tree `path`; the root note is `""`). */
  path: string;
  /** Repo-relative path of the Markdown file backing the note. */
  file: string;
  /** Canonical Markdown content of the note. */
  markdown: string;
}

/**
 * Normalize a note identity to its canonical tree-path form: POSIX slashes, no
 * surrounding slashes, and no `.md` extension.
 */
export function normalizeNotePath(path: string): string {
  return path
    .replace(/\\/gu, "/")
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.md$/iu, "");
}

/**
 * Backing-file candidates for a note identity, in resolution priority.
 *
 * A note is either a **leaf** (`path.md`) or a **parent** (`path/_index.md`); the
 * root note (`""`) is backed by the repo-root `_index.md`. The reader tries each
 * candidate in order and uses the first that exists.
 */
export function noteFileCandidates(path: string): string[] {
  const clean = normalizeNotePath(path);
  if (clean === "") return [INDEX_FILE];
  return [`${clean}.md`, `${clean}/${INDEX_FILE}`];
}
