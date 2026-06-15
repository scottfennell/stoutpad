/**
 * The git-engine read seam.
 *
 * `core/git-engine` is the deep module that reads the working clone; per the
 * project conventions the actual filesystem/Git access is a Node concern that
 * lives in `apps/server`. This file defines the runtime-agnostic contract the
 * server implements, plus the pure compositions that turn the files it reads
 * into a {@link NoteTreeResponse} (whole tree) or a {@link NoteContentResponse}
 * (a single note's Markdown). Keeping the interface here lets the HTTP layer
 * depend on an injected engine (real Git in production, a fake in tests) and
 * lets a future browser/`isomorphic-git` backend drop in unchanged.
 */

import { buildNoteTree, type NoteFile, type NoteTreeResponse } from "./note-tree.js";
import {
  noteFileCandidates,
  normalizeNotePath,
  type NoteContentResponse,
} from "./note-content.js";

/** Reads the note files from a Git working clone. */
export interface GitEngine {
  /**
   * List the Markdown note files tracked in the working clone, as repo-relative
   * POSIX paths (e.g. `_index.md`, `projects/_index.md`).
   */
  listNoteFiles(): Promise<NoteFile[]>;
  /**
   * Read a single note file's UTF-8 content by repo-relative POSIX path, or
   * resolve to `null` when no such file exists in the working clone.
   */
  readNoteFile(path: string): Promise<string | null>;
}

/**
 * Read the working clone via the injected {@link GitEngine} and map it into the
 * unified note tree. The Node/Git side stays in the engine; the mapping stays
 * pure.
 */
export async function readNoteTree(
  engine: GitEngine,
  options?: { rootTitle?: string },
): Promise<NoteTreeResponse> {
  const files = await engine.listNoteFiles();
  return { root: buildNoteTree(files, options) };
}

/**
 * Read a single note's canonical Markdown by its identity (tree `path`) via the
 * injected {@link GitEngine}. Resolves the identity to its backing file (leaf
 * `path.md` or parent `path/_index.md`) and returns the first that exists, or
 * `null` when the note is missing — the HTTP layer maps that to a 404. The
 * identity → file resolution stays pure; only the read touches the engine.
 */
export async function readNote(
  engine: GitEngine,
  notePath: string,
): Promise<NoteContentResponse | null> {
  for (const file of noteFileCandidates(notePath)) {
    const markdown = await engine.readNoteFile(file);
    if (markdown !== null) {
      return { path: normalizeNotePath(notePath), file, markdown };
    }
  }
  return null;
}
