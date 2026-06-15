/**
 * Note-tree mutation: create / rename / move + the leaf↔parent transition.
 *
 * Where `core/note-tree` maps a flat file set *into* the tree (read), this module
 * computes how to *mutate* the file set behind the tree (write). It is the pure,
 * runtime-agnostic planner: given the current files and a requested op
 * (create / rename / move), it returns the backing-file operations git must
 * perform — including the structural transitions that make "folders are just
 * notes with children" hold:
 *
 * - **Leaf → parent promotion.** Giving a leaf note `Foo.md` its first child
 *   promotes it to a directory note: `Foo.md` → `Foo/_index.md`, then the child
 *   `Foo/<child>.md` is created. The parent's tree `path` identity is preserved.
 * - **Parent → leaf collapse.** Moving a parent's *last* child away collapses it
 *   back to a leaf: `Foo/_index.md` → `Foo.md`. Symmetric with promotion, and
 *   automatic (see `docs/adr/0005-note-mutations-and-leaf-parent-transition.md`).
 *   The root note never collapses.
 * - **Whole-subtree move.** Moving/renaming a parent note moves its entire
 *   directory as a single directory move (`Foo` → `Bar`), carrying `_index.md`
 *   and every descendant with it.
 *
 * The plan is pure data; the Git side (`apps/server`) applies it as one atomic
 * commit through the {@link MutatingGitEngine} seam, mirroring how the read tree
 * stays pure while the engine does the IO. The thin compositions
 * {@link createNote} / {@link renameNote} / {@link moveNote} read the current
 * files, build a plan, and hand it to the engine — the counterparts to
 * `readNote` / `writeNote`.
 */

import {
  INDEX_FILE,
  deriveTitle,
  type NoteFile,
} from "./note-tree.js";
import { normalizeNotePath } from "./note-content.js";

/** REST path for creating a new note (`POST`). */
export const NOTE_CREATE_PATH = "/api/note/create" as const;
/** REST path for renaming a note in place (`POST`). */
export const NOTE_RENAME_PATH = "/api/note/rename" as const;
/** REST path for moving a note to a different parent (`POST`). */
export const NOTE_MOVE_PATH = "/api/note/move" as const;

/**
 * A backing-file move. A `file` move renames a single Markdown file (a leaf, or
 * the `_index.md` of a promotion/collapse); a `dir` move renames a whole
 * directory subtree (a parent note and all its descendants) in one go.
 */
export interface MutationMove {
  /** Source path: a file (`foo.md`) or a directory (`foo`). */
  from: string;
  /** Destination path, matching the `kind` of `from`. */
  to: string;
  /** Whether this renames a single file or a whole directory. */
  kind: "file" | "dir";
}

/** A brand-new backing file to create (e.g. a fresh leaf note). */
export interface MutationCreate {
  /** Repo-relative POSIX path of the file to write. */
  path: string;
  /** UTF-8 content to write (already canonical Markdown). */
  content: string;
}

/**
 * The backing-file operations a single note mutation performs, applied by the
 * engine as **one atomic commit**. Order matters: `moves` run first (destination
 * promotion, then the note itself, then source collapse), then `creates`, then
 * `removes`.
 */
export interface NoteMutation {
  /** Renames to perform (file or directory). */
  moves: MutationMove[];
  /** New files to create. */
  creates: MutationCreate[];
  /** Files to delete. */
  removes: string[];
  /** Commit message for the single atomic commit. */
  message: string;
}

/** A {@link NoteMutation} plus the identity it produces, returned by the planners. */
export interface NoteMutationPlan extends NoteMutation {
  /** Resulting identity (tree `path`) of the affected note. */
  notePath: string;
  /** Resulting backing file of the affected note. */
  file: string;
}

/** Response body of the create / rename / move endpoints. */
export interface NoteMutationResponse {
  /** Resulting identity (tree `path`) of the affected note. */
  path: string;
  /** Resulting backing file of the affected note. */
  file: string;
}

/** Request body of `POST /api/note/create`. */
export interface NoteCreateRequest {
  /** Identity of the parent note to create the new leaf under (root is `""`). */
  parent: string;
  /** Human-friendly name for the new note (slugified into the file name). */
  name: string;
}

/** Request body of `POST /api/note/rename`. */
export interface NoteRenameRequest {
  /** Identity of the note to rename. */
  path: string;
  /** New human-friendly name (slugified into the file name). */
  name: string;
}

/** Request body of `POST /api/note/move`. */
export interface NoteMoveRequest {
  /** Identity of the note to move. */
  path: string;
  /** Identity of the destination parent note (root is `""`). */
  parent: string;
}

/**
 * A rejected mutation due to invalid input (bad name, duplicate target, moving a
 * note into its own subtree, …). The HTTP layer maps it to a 400; other thrown
 * errors stay 500, mirroring how the read/write routes treat engine failures.
 */
export class NoteMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteMutationError";
  }
}

/**
 * Turn a human-friendly note name into a safe, kebab-case file slug.
 *
 * Pure and deterministic: drops any `.md`, lowercases, replaces every run of
 * non-alphanumeric characters with a single dash, and trims leading/trailing
 * dashes — so `"My Ideas"` → `"my-ideas"`, which {@link deriveTitle} humanizes
 * straight back to `"My Ideas"`. Returns `""` for a name with no usable
 * characters, which the planners reject.
 */
export function slugifyNoteName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\.md$/iu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/** The set of tracked Markdown file paths, for existence probes. */
function fileSet(files: NoteFile[]): Set<string> {
  return new Set(files.map((f) => f.path));
}

/** Parent identity of a note path (everything before the last `/`). */
function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Last path segment (the note's own name). */
function lastSegment(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Whether any file lives strictly under the `path/` directory. */
function anyFileUnder(set: Set<string>, path: string): boolean {
  if (path === "") return set.size > 0;
  const prefix = `${path}/`;
  for (const file of set) if (file.startsWith(prefix)) return true;
  return false;
}

/** Classify whether an identity currently backs a leaf and/or a parent note. */
function classify(
  set: Set<string>,
  path: string,
): { leaf: boolean; parent: boolean } {
  const leaf = set.has(`${path}.md`);
  const parent = set.has(`${path}/${INDEX_FILE}`) || anyFileUnder(set, path);
  return { leaf, parent };
}

/** Whether an identity already names an existing note (leaf or parent). */
function noteExists(set: Set<string>, path: string): boolean {
  const { leaf, parent } = classify(set, path);
  return leaf || parent;
}

/** Throw unless `parent` is the root or an existing note that can hold children. */
function assertParentExists(set: Set<string>, parent: string): void {
  if (parent === "") return;
  if (!noteExists(set, parent)) {
    throw new NoteMutationError(`parent note does not exist: ${parent}`);
  }
}

/** Throw if a note already occupies the target identity. */
function assertVacant(set: Set<string>, path: string): void {
  if (noteExists(set, path)) {
    throw new NoteMutationError(`a note already exists at ${path}`);
  }
}

/** The current backing file of an existing note (leaf preferred). */
function backingFile(set: Set<string>, path: string): string {
  if (path === "") return INDEX_FILE;
  if (set.has(`${path}.md`)) return `${path}.md`;
  return `${path}/${INDEX_FILE}`;
}

/** A no-op plan (no moves/creates): the engine commits nothing. */
function noopPlan(notePath: string, file: string): NoteMutationPlan {
  return { moves: [], creates: [], removes: [], message: "", notePath, file };
}

/** The promotion move that turns a leaf parent into a directory, if needed. */
function promoteIfLeaf(set: Set<string>, parent: string): MutationMove[] {
  if (parent !== "" && set.has(`${parent}.md`)) {
    return [{ from: `${parent}.md`, to: `${parent}/${INDEX_FILE}`, kind: "file" }];
  }
  return [];
}

/**
 * Plan the creation of a new leaf note named `name` under `parentPath`.
 *
 * Slugifies the name into the backing file `<parent>/<slug>.md`, and — when the
 * parent is itself a leaf — prepends the leaf→parent promotion of the parent
 * (`<parent>.md` → `<parent>/_index.md`) so the new note has somewhere to live.
 */
export function planCreateNote(
  files: NoteFile[],
  parentPath: string,
  name: string,
  options: { content?: string; message?: string } = {},
): NoteMutationPlan {
  const parent = normalizeNotePath(parentPath);
  const slug = slugifyNoteName(name);
  if (slug === "" || slug === "_index") {
    throw new NoteMutationError(`invalid note name: ${JSON.stringify(name)}`);
  }
  const set = fileSet(files);
  assertParentExists(set, parent);

  const notePath = parent === "" ? slug : `${parent}/${slug}`;
  assertVacant(set, notePath);

  const file = `${notePath}.md`;
  const content = options.content ?? `# ${deriveTitle(slug)}\n`;
  return {
    moves: promoteIfLeaf(set, parent),
    creates: [{ path: file, content }],
    removes: [],
    notePath,
    file,
    message: options.message ?? `Create note ${notePath}`,
  };
}

/**
 * Plan renaming a note in place (same parent, new name). A leaf renames its
 * single file; a parent renames its whole directory subtree as one `dir` move,
 * carrying `_index.md` and every descendant. Renaming to the current name is a
 * no-op plan.
 */
export function planRenameNote(
  files: NoteFile[],
  notePath: string,
  newName: string,
): NoteMutationPlan {
  const path = normalizeNotePath(notePath);
  if (path === "") throw new NoteMutationError("cannot rename the root note");

  const set = fileSet(files);
  const { leaf, parent } = classify(set, path);
  if (!leaf && !parent) {
    throw new NoteMutationError(`note does not exist: ${path}`);
  }

  const slug = slugifyNoteName(newName);
  if (slug === "" || slug === "_index") {
    throw new NoteMutationError(`invalid note name: ${JSON.stringify(newName)}`);
  }

  const parentPath = parentOf(path);
  const newPath = parentPath === "" ? slug : `${parentPath}/${slug}`;
  if (newPath === path) return noopPlan(path, backingFile(set, path));
  assertVacant(set, newPath);

  if (leaf) {
    return {
      moves: [{ from: `${path}.md`, to: `${newPath}.md`, kind: "file" }],
      creates: [],
      removes: [],
      notePath: newPath,
      file: `${newPath}.md`,
      message: `Rename note ${path} to ${newPath}`,
    };
  }
  return {
    moves: [{ from: path, to: newPath, kind: "dir" }],
    creates: [],
    removes: [],
    notePath: newPath,
    file: `${newPath}/${INDEX_FILE}`,
    message: `Rename note ${path} to ${newPath}`,
  };
}

/**
 * Plan moving a note (keeping its name) under a different parent.
 *
 * Composes up to three structural steps into one atomic mutation:
 * 1. **Promote** the destination parent if it is currently a leaf.
 * 2. **Move** the note — a single file for a leaf, the whole directory subtree
 *    for a parent.
 * 3. **Collapse** the source parent back to a leaf if this removed its last
 *    child (never the root).
 *
 * Rejects moving a note into itself or its own descendant, and moving onto an
 * occupied identity. Moving to the parent it already lives under is a no-op.
 */
export function planMoveNote(
  files: NoteFile[],
  notePath: string,
  newParentPath: string,
): NoteMutationPlan {
  const path = normalizeNotePath(notePath);
  if (path === "") throw new NoteMutationError("cannot move the root note");

  const set = fileSet(files);
  const { leaf, parent } = classify(set, path);
  if (!leaf && !parent) {
    throw new NoteMutationError(`note does not exist: ${path}`);
  }

  const newParent = normalizeNotePath(newParentPath);
  const srcParent = parentOf(path);
  if (newParent === srcParent) return noopPlan(path, backingFile(set, path));
  if (newParent === path || newParent.startsWith(`${path}/`)) {
    throw new NoteMutationError(`cannot move ${path} into its own subtree`);
  }
  assertParentExists(set, newParent);

  const name = lastSegment(path);
  const newPath = newParent === "" ? name : `${newParent}/${name}`;
  assertVacant(set, newPath);

  const moves: MutationMove[] = [...promoteIfLeaf(set, newParent)];

  let file: string;
  if (leaf) {
    moves.push({ from: `${path}.md`, to: `${newPath}.md`, kind: "file" });
    file = `${newPath}.md`;
  } else {
    moves.push({ from: path, to: newPath, kind: "dir" });
    file = `${newPath}/${INDEX_FILE}`;
  }

  moves.push(...collapseIfLastChild(set, srcParent, path));

  return {
    moves,
    creates: [],
    removes: [],
    notePath: newPath,
    file,
    message: `Move note ${path} to ${newPath}`,
  };
}

/**
 * The collapse move for `srcParent` if removing the note at `path` leaves it
 * with no remaining children. Only a parent backed by an `_index.md` (never the
 * root, never an implied parent) collapses, mirroring promotion.
 */
function collapseIfLastChild(
  set: Set<string>,
  srcParent: string,
  path: string,
): MutationMove[] {
  if (srcParent === "" || !set.has(`${srcParent}/${INDEX_FILE}`)) return [];
  const movedFile = `${path}.md`;
  const movedDir = `${path}/`;
  const prefix = `${srcParent}/`;
  for (const file of set) {
    if (!file.startsWith(prefix)) continue;
    if (file === `${srcParent}/${INDEX_FILE}`) continue;
    if (file === movedFile || file.startsWith(movedDir)) continue;
    return []; // a sibling remains — the parent stays a parent
  }
  return [{ from: `${srcParent}/${INDEX_FILE}`, to: `${srcParent}.md`, kind: "file" }];
}

/**
 * Apply a {@link NoteMutation} to a flat file set, purely — the in-memory
 * counterpart to the Git engine. Used to unit-test the planners (feed the result
 * to `buildNoteTree`) and by in-memory engine doubles. Tracks paths only.
 */
export function applyNoteMutationToFiles(
  files: NoteFile[],
  mutation: NoteMutation,
): NoteFile[] {
  const paths = new Set(files.map((f) => f.path));
  for (const move of mutation.moves) {
    if (move.kind === "file") {
      paths.delete(move.from);
      paths.add(move.to);
    } else {
      const prefix = `${move.from}/`;
      for (const path of [...paths]) {
        if (path === move.from || path.startsWith(prefix)) {
          paths.delete(path);
          paths.add(`${move.to}${path.slice(move.from.length)}`);
        }
      }
    }
  }
  for (const create of mutation.creates) paths.add(create.path);
  for (const remove of mutation.removes) paths.delete(remove);
  return [...paths].sort().map((path) => ({ path }));
}

/**
 * A {@link GitEngine} that can apply a {@link NoteMutation} (the create / rename /
 * move ops, including leaf↔parent transitions) as one atomic commit.
 *
 * The narrow primitive is `applyNoteMutation`; the pure {@link createNote} /
 * {@link renameNote} / {@link moveNote} compositions plan against the current
 * files and delegate the IO here, mirroring `WritableGitEngine` / `writeNote`.
 */
export interface MutatingGitEngine {
  /** List the Markdown note files tracked in the working clone. */
  listNoteFiles(): Promise<NoteFile[]>;
  /** Perform the mutation's moves/creates/removes as a single commit. */
  applyNoteMutation(mutation: NoteMutation): Promise<void>;
}

/** Create a new leaf note under `parentPath`; promotes the parent if it is a leaf. */
export async function createNote(
  engine: MutatingGitEngine,
  parentPath: string,
  name: string,
  options?: { content?: string; message?: string },
): Promise<NoteMutationResponse> {
  const plan = planCreateNote(await engine.listNoteFiles(), parentPath, name, options);
  await engine.applyNoteMutation(plan);
  return { path: plan.notePath, file: plan.file };
}

/** Rename a note in place (whole subtree for a parent). */
export async function renameNote(
  engine: MutatingGitEngine,
  notePath: string,
  newName: string,
): Promise<NoteMutationResponse> {
  const plan = planRenameNote(await engine.listNoteFiles(), notePath, newName);
  await engine.applyNoteMutation(plan);
  return { path: plan.notePath, file: plan.file };
}

/** Move a note under a different parent; promotes/collapses as needed. */
export async function moveNote(
  engine: MutatingGitEngine,
  notePath: string,
  newParentPath: string,
): Promise<NoteMutationResponse> {
  const plan = planMoveNote(await engine.listNoteFiles(), notePath, newParentPath);
  await engine.applyNoteMutation(plan);
  return { path: plan.notePath, file: plan.file };
}
