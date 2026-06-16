/**
 * The unified note tree.
 *
 * Stout presents a single hierarchy of notes; "folders are just notes that have
 * children". This module is the deep, runtime-agnostic mapper that turns a flat
 * set of repository files into that tree. It is pure: no Node, no DOM, no Git —
 * it only knows about file paths. The Node/Git reading lives in the server,
 * which feeds the file list in here.
 *
 * Identity model (see `docs/adr/0001-note-tree-identity-and-git-storage.md`):
 * - A **leaf note** is backed by a regular `name.md` file. Its title derives
 *   from the file name.
 * - A **parent note** is a directory containing an `_index.md`. The directory
 *   may also hold child notes. Its title derives from the folder name, and its
 *   content lives in the `_index.md`.
 * - The repository root is itself a parent note backed by the root `_index.md`.
 * - A note's identity is its tree `path` (the repo path without the `.md`
 *   extension and without the trailing `_index`), so a leaf↔parent transition is
 *   a single `git mv` that preserves identity.
 */

/** Conventional file name that turns a directory into a parent note. */
export const INDEX_FILE = "_index.md" as const;

/** REST path of the read-only note-tree endpoint. */
export const TREE_PATH = "/api/tree" as const;

/** Whether a note can contain children (`parent`) or not (`leaf`). */
export type NoteKind = "parent" | "leaf";

/** A single Markdown file tracked in the working clone. */
export interface NoteFile {
  /** Repo-relative POSIX path, e.g. `_index.md`, `projects/_index.md`. */
  path: string;
  /**
   * Display title from the file's frontmatter `title:`, when it has one. Lets a
   * note override the title derived from its file/folder name; absent means
   * "derive the title from the name" (the default).
   */
  title?: string;
}

/** A node in the unified note tree. */
export interface NoteNode {
  /**
   * Stable identity of the note: its repo path with the `.md` extension and any
   * trailing `_index` removed. The root note has the empty-string path.
   */
  path: string;
  /** Display title derived from the folder name (parent) or file name (leaf). */
  title: string;
  /**
   * Repo-relative path of the Markdown file backing this note, or `null` for an
   * implied parent (a directory with children but no `_index.md` yet).
   */
  file: string | null;
  /** Whether this note may hold children. */
  kind: NoteKind;
  /** Child notes, sorted by title then path. */
  children: NoteNode[];
}

/** Response body of `GET /api/tree`. */
export interface NoteTreeResponse {
  /** Root note of the workspace, backed by the repo-root `_index.md`. */
  root: NoteNode;
}

/** Options controlling how the tree is built. */
export interface BuildNoteTreeOptions {
  /** Title for the root note (the repo root has no folder name). */
  rootTitle?: string;
}

/**
 * Map a flat set of repository files into the unified note tree.
 *
 * Pure and deterministic: the result does not depend on input order, non-`.md`
 * files are ignored, and children are sorted by title then path. Always returns
 * a single root node (the workspace), even for an empty input.
 */
export function buildNoteTree(
  files: NoteFile[],
  options: BuildNoteTreeOptions = {},
): NoteNode {
  const root: NoteNode = {
    path: "",
    title: options.rootTitle ?? "Home",
    file: null,
    kind: "parent",
    children: [],
  };

  /** Parent (directory) nodes by their tree path; `""` is the root. */
  const dirNodes = new Map<string, NoteNode>([["", root]]);

  /** Lazily create the parent node for a directory and all its ancestors. */
  const ensureDirNode = (dirPath: string): NoteNode => {
    const existing = dirNodes.get(dirPath);
    if (existing) return existing;

    const segments = dirPath.split("/");
    const name = segments.pop() as string;
    const parent = ensureDirNode(segments.join("/"));
    const node: NoteNode = {
      path: dirPath,
      title: deriveTitle(name),
      file: null,
      kind: "parent",
      children: [],
    };
    dirNodes.set(dirPath, node);
    parent.children.push(node);
    return node;
  };

  const seen = new Set<string>();
  const mdFiles = files
    .map((f) => ({ path: normalizePath(f.path), title: f.title }))
    .filter((f) => f.path.length > 0 && f.path.toLowerCase().endsWith(".md"))
    // Sort so `_index.md` is processed before siblings and the result is stable.
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const { path, title } of mdFiles) {
    if (seen.has(path)) continue;
    seen.add(path);

    const segments = path.split("/");
    const fileName = segments.pop() as string;
    const dirPath = segments.join("/");

    if (fileName.toLowerCase() === INDEX_FILE) {
      // Backs the directory note (the repo root for a top-level `_index.md`).
      const node = ensureDirNode(dirPath);
      node.file = path;
      // A frontmatter `title:` overrides the folder-derived (or root) title.
      if (title) node.title = title;
      continue;
    }

    const parent = ensureDirNode(dirPath);
    const stem = stripMarkdownExtension(fileName);
    parent.children.push({
      path: dirPath ? `${dirPath}/${stem}` : stem,
      // A frontmatter `title:` overrides the file-name-derived title.
      title: title ?? deriveTitle(fileName),
      file: path,
      kind: "leaf",
      children: [],
    });
  }

  sortTree(root);
  return root;
}

/**
 * Derive a human-friendly title from a file or folder name: drop the `.md`
 * extension, split on `-`/`_`/whitespace, and capitalize each word.
 */
export function deriveTitle(name: string): string {
  const stem = stripMarkdownExtension(name);
  const words = stem.split(/[\s_-]+/u).filter(Boolean);
  if (words.length === 0) return stem;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function stripMarkdownExtension(name: string): string {
  return name.replace(/\.md$/iu, "");
}

/** Normalize to repo-relative POSIX form (forward slashes, no leading `./`). */
function normalizePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\.?\/+/u, "");
}

function sortTree(node: NoteNode): void {
  node.children.sort(
    (a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path),
  );
  for (const child of node.children) sortTree(child);
}
