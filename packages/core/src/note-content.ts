/**
 * The note-content read & write contract.
 *
 * A note's **identity** is its tree `path` (see `core/note-tree`). To open a note
 * the HTTP layer resolves that identity to the Markdown file backing it and
 * returns the file's canonical Markdown; to save one it sends the edited Markdown
 * back, which is canonicalized and committed. This module owns the pure pieces of
 * that contract — the REST path, the request/response shapes, and the identity →
 * backing-file resolution — so the Node/Git read and write stay thin, injectable
 * seams in `apps/server`. The engine compositions (`readNote`/`writeNote`) live
 * alongside {@link readNoteTree} in `core/git-engine`.
 *
 * The single endpoint `/api/note` is read on `GET` (`?path=<identity>`) and
 * written on `POST` (a {@link NoteSaveRequest} body).
 */

import { INDEX_FILE } from "./note-tree.js";

/** REST path of the single-note endpoint: `GET` reads, `POST` saves. */
export const NOTE_PATH = "/api/note" as const;

/** Response body of `GET /api/note` (and of a successful `POST /api/note`). */
export interface NoteContentResponse {
  /** Stable identity of the note (its tree `path`; the root note is `""`). */
  path: string;
  /** Repo-relative path of the Markdown file backing the note. */
  file: string;
  /** Canonical Markdown content of the note. */
  markdown: string;
}

/**
 * Request body of `POST /api/note` — save a note's content.
 *
 * The `markdown` is canonicalized server-side (see `serializeMarkdown`) before it
 * is written and committed, so the persisted file is always canonical CommonMark
 * + GFM regardless of how the editor formatted its output.
 */
export interface NoteSaveRequest {
  /** Identity (tree `path`) of the note to save; the root note is `""`. */
  path: string;
  /** Edited Markdown content (canonicalized before writing). */
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

/** Identity (tree `path`) of the parent-note `_index.md` stem, e.g. `_index`. */
const INDEX_STEM = INDEX_FILE.replace(/\.md$/iu, "");

/**
 * Resolve a repo-relative backing **file** to the note **identity** it backs —
 * the inverse of {@link noteFileCandidates} for a single file.
 *
 * A leaf file `dir/name.md` backs `dir/name`; a parent file `dir/_index.md` backs
 * the directory `dir`; the repo-root `_index.md` backs the root note (`""`). This
 * is the same identity {@link buildNoteTree} assigns, so mapping a file list
 * through here agrees with the tree. Pure.
 */
export function noteIdentityForFile(file: string): string {
  const clean = normalizeNotePath(file);
  if (clean === INDEX_STEM) return "";
  if (clean.endsWith(`/${INDEX_STEM}`)) return clean.slice(0, -(INDEX_STEM.length + 1));
  return clean;
}
