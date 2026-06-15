/**
 * The git-engine read seam.
 *
 * `core/git-engine` is the deep module that reads the working clone; per the
 * project conventions the actual filesystem/Git access is a Node concern that
 * lives in `apps/server`. This file defines the runtime-agnostic contract the
 * server implements, plus the pure composition that turns the files it reads
 * into a {@link NoteTreeResponse}. Keeping the interface here lets the HTTP layer
 * depend on an injected engine (real Git in production, a fake in tests) and
 * lets a future browser/`isomorphic-git` backend drop in unchanged.
 */

import { buildNoteTree, type NoteFile, type NoteTreeResponse } from "./note-tree.js";

/** Reads the note files from a Git working clone. */
export interface GitEngine {
  /**
   * List the Markdown note files tracked in the working clone, as repo-relative
   * POSIX paths (e.g. `_index.md`, `projects/_index.md`).
   */
  listNoteFiles(): Promise<NoteFile[]>;
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
