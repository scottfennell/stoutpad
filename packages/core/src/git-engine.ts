/**
 * The git-engine read & write seam.
 *
 * `core/git-engine` is the deep module that reads and writes the working clone;
 * per the project conventions the actual filesystem/Git access is a Node concern
 * that lives in `apps/server`. This file defines the runtime-agnostic contracts
 * the server implements ({@link GitEngine} for reads, {@link WritableGitEngine}
 * for commit-on-save), plus the pure compositions that turn the files it reads
 * into a {@link NoteTreeResponse} (whole tree) or a {@link NoteContentResponse}
 * (a single note's Markdown), and that canonicalize + persist an edit
 * ({@link writeNote}). Keeping the interfaces here lets the HTTP layer depend on
 * an injected engine (real Git in production, an in-memory fake in tests) and
 * lets a future browser/`isomorphic-git` backend drop in unchanged.
 */

import { buildNoteTree, type NoteFile, type NoteNode, type NoteTreeResponse } from "./note-tree.js";
import {
  noteFileCandidates,
  normalizeNotePath,
  type NoteContentResponse,
} from "./note-content.js";
import { canonicalizeMarkdown, parseFrontmatter } from "./markdown.js";
import {
  buildLinkGraph,
  buildTitleIndex,
  type LinkGraphResponse,
  type NoteContent,
} from "./wikilink.js";

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
 * A {@link GitEngine} that can also persist a note: write a file in the working
 * clone and commit it to `main` in one step.
 *
 * Keeping the write behind an interface (mirroring the `MigrationStore` seam)
 * lets the pure {@link writeNote} composition be tested against an in-memory
 * double, while production uses the Node implementation that shells out to `git`.
 */
export interface WritableGitEngine extends GitEngine {
  /**
   * Write `content` to the note file at `path` (repo-relative POSIX) in the
   * working clone and commit it to `main` with `message`. Implementations must
   * guard against path escapes and should skip the commit when the content is
   * unchanged (no empty commits). Resolves once the commit (if any) is recorded.
   */
  writeNoteFile(path: string, content: string, message: string): Promise<void>;
}

/**
 * Read the working clone via the injected {@link GitEngine} and map it into the
 * unified note tree. The Node/Git side stays in the engine; the mapping stays
 * pure.
 *
 * Each note file is read so a frontmatter `title:` can override the title
 * derived from its file/folder name (the `title` is parsed purely by
 * {@link parseFrontmatter}). Files are read concurrently and a missing read
 * simply leaves the derived title in place.
 */
export async function readNoteTree(
  engine: GitEngine,
  options?: { rootTitle?: string },
): Promise<NoteTreeResponse> {
  const files = await engine.listNoteFiles();
  const withTitles = await Promise.all(
    files.map(async (file): Promise<NoteFile> => {
      const markdown = await engine.readNoteFile(file.path);
      const title =
        markdown === null ? undefined : parseFrontmatter(markdown).frontmatter?.title;
      return { ...file, title };
    }),
  );
  return { root: buildNoteTree(withTitles, options) };
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

/**
 * Resolve the backing file a save should target for a note identity.
 *
 * Prefers the note's existing backing file (so editing a parent note writes its
 * `_index.md`, not a sibling leaf), falling back to the leaf candidate (`path.md`,
 * or the root `_index.md`) when the note does not exist yet. Pure but for the
 * existence probes through the engine. Shared by commit-on-save ({@link writeNote})
 * and the Node engine's wip autosave so both target the same backing file.
 */
export async function resolveWriteTarget(
  engine: GitEngine,
  notePath: string,
): Promise<string> {
  const candidates = noteFileCandidates(notePath);
  for (const file of candidates) {
    if ((await engine.readNoteFile(file)) !== null) return file;
  }
  return candidates[0];
}

/**
 * Persist a note's edited Markdown via the injected {@link WritableGitEngine}.
 *
 * The Markdown is **canonicalized** ({@link canonicalizeMarkdown}) before it is
 * written, so the committed file is always byte-stable canonical CommonMark + GFM.
 * Resolves the note identity to its backing file, writes + commits it to `main`,
 * and returns the saved {@link NoteContentResponse} (carrying the canonical
 * Markdown the client should adopt). The canonicalization and identity → file
 * resolution stay pure; only the write/commit touches the engine.
 */
export async function writeNote(
  engine: WritableGitEngine,
  notePath: string,
  markdown: string,
): Promise<NoteContentResponse> {
  const canonical = canonicalizeMarkdown(markdown);
  const file = await resolveWriteTarget(engine, notePath);
  await engine.writeNoteFile(file, canonical, `Edit ${file}`);
  return { path: normalizeNotePath(notePath), file, markdown: canonical };
}

/**
 * Read every note's Markdown via the injected {@link GitEngine} and build the
 * unified {@link LinkGraphResponse link graph} of `[[wikilinks]]` between notes.
 *
 * The Node/Git reads (listing files, reading each backing file) stay in the
 * engine; the tree mapping, title indexing, and link resolution stay pure
 * (`core/note-tree`, `core/wikilink`). Notes are visited in tree order, so the
 * resulting graph is deterministic. The server exposes this at `GET /api/links`.
 */
export async function readLinkGraph(engine: GitEngine): Promise<LinkGraphResponse> {
  const files = await engine.listNoteFiles();
  const root = buildNoteTree(files);
  const index = buildTitleIndex(root);

  const notes: NoteContent[] = [];
  const visit = async (node: NoteNode): Promise<void> => {
    if (node.file !== null) {
      const markdown = await engine.readNoteFile(node.file);
      if (markdown !== null) {
        notes.push({ path: node.path, title: node.title, markdown });
      }
    }
    for (const child of node.children) await visit(child);
  };
  await visit(root);

  return buildLinkGraph(notes, index);
}
