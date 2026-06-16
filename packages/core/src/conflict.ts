/**
 * `core/conflict` — the multi-device conflict policy (zero data loss).
 *
 * When the same note is edited on two devices that then sync to the same `main`,
 * the two histories diverge. This module is the runtime-agnostic policy for
 * reconciling that divergence, with one guiding rule: **never lose an edit.**
 *
 * 1. **Auto-merge non-overlapping changes.** Given the common ancestor (`base`),
 *    this device's `local` content, and the `incoming` `main` content, a pure
 *    line-level three-way merge ({@link mergeNoteContent}) combines edits that
 *    touch different regions into a single clean result — no user involvement.
 * 2. **Keep both on a true conflict.** When both sides changed the *same* region
 *    differently, the note **keeps the incoming `main` version** and the local
 *    version is written verbatim to a **sibling conflict-copy note**
 *    (`<Title> (conflict copy <marker>)`), so nothing is overwritten. A
 *    non-blocking {@link ConflictNotification} tells the user a copy was made.
 *
 * Everything here is pure: the three-way merge, the conflict-copy planning, and
 * the notification are computed from strings and identities. The only IO is
 * {@link applyConflictResolution}, which writes the resolved content through the
 * injected {@link WritableGitEngine} seam (real Git in the server, an
 * `isomorphic-git`/IndexedDB engine in the browser, an in-memory fake in tests) —
 * mirroring how `applyNoteSync` keeps the policy in `core` and the IO at the edge.
 *
 * See `docs/adr/0011-pwa-offline-and-conflict-policy.md`.
 */

import { canonicalizeMarkdown, parseMarkdown, serializeMarkdown, type Frontmatter } from "./markdown.js";
import { normalizeNotePath } from "./note-content.js";
import { writeNote, type WritableGitEngine } from "./git-engine.js";
import { deriveTitle } from "./note-tree.js";
import { slugifyNoteName } from "./note-mutation.js";

/** A three-way merge input: the common ancestor and the two diverged versions. */
export interface ThreeWayInput {
  /** Common ancestor: the canonical Markdown both sides diverged from. */
  base: string;
  /** This device's canonical Markdown (the local edit). */
  local: string;
  /** The incoming `main` canonical Markdown (the other device's edit). */
  incoming: string;
}

/**
 * The outcome of a three-way merge: either a single clean result (auto-merged or
 * fast-forwarded), or a true conflict carrying both canonical sides so the
 * caller can keep both.
 */
export type MergeResult =
  | {
      status: "clean";
      /** The canonical Markdown the note should hold. */
      markdown: string;
      /**
       * Whether a non-trivial three-way merge combined both sides' edits (as
       * opposed to a fast-forward where only one side changed). Informational.
       */
      merged: boolean;
    }
  | {
      status: "conflict";
      /** The incoming `main` version (canonical). */
      incoming: string;
      /** This device's local version (canonical). */
      local: string;
    };

/**
 * Three-way merge a note's content (`base` → `local` vs `incoming`), purely.
 *
 * All three inputs are canonicalized first, so the merge operates on stable
 * canonical lines and the result is itself canonical. Resolution order:
 * - identical sides (`local === incoming`) → clean, that content;
 * - only `incoming` changed (`base === local`) → clean fast-forward to incoming;
 * - only `local` changed (`base === incoming`) → clean, keep local;
 * - otherwise a line-level diff3: regions only one side touched are taken
 *   automatically; a region both sides changed differently is a **conflict**.
 *
 * Deterministic and dependency-free.
 */
export function mergeNoteContent(input: ThreeWayInput): MergeResult {
  const base = canonicalizeMarkdown(input.base);
  const local = canonicalizeMarkdown(input.local);
  const incoming = canonicalizeMarkdown(input.incoming);

  if (local === incoming) return { status: "clean", markdown: incoming, merged: false };
  if (base === local) return { status: "clean", markdown: incoming, merged: false };
  if (base === incoming) return { status: "clean", markdown: local, merged: false };

  const merged = diff3Merge(splitLines(base), splitLines(local), splitLines(incoming));
  if (merged === null) return { status: "conflict", incoming, local };

  const markdown = canonicalizeMarkdown(merged.join("\n"));
  return { status: "clean", markdown, merged: markdown !== incoming };
}

/** Split canonical Markdown into lines for line-level diffing. */
function splitLines(markdown: string): string[] {
  return markdown.split("\n");
}

/** Whether two string arrays are element-wise equal. */
function linesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The matched index pairs of the longest common subsequence of `x` and `y`, in
 * increasing order of both indices. The pure backbone of the three-way merge.
 */
function lcsPairs(x: string[], y: string[]): Array<[number, number]> {
  const m = x.length;
  const n = y.length;
  // dp[i][j] = LCS length of x[i:] and y[j:].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (x[i] === y[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * Line-level diff3 merge of `local` (A) and `incoming` (B) against their common
 * ancestor `base` (O). Returns the merged lines, or `null` when a region was
 * changed differently on both sides (a true conflict).
 *
 * Walks `base` with three cursors, using the LCS of (base, local) and
 * (base, incoming) to find **sync lines** — base lines matched in *both* sides —
 * which bound the unstable regions between them. For each unstable region:
 * identical on both sides ⇒ take it; one side equals base ⇒ take the other side's
 * change; both differ from base and from each other ⇒ conflict.
 */
function diff3Merge(base: string[], local: string[], incoming: string[]): string[] | null {
  const matchA = new Map<number, number>(lcsPairs(base, local));
  const matchB = new Map<number, number>(lcsPairs(base, incoming));

  const merged: string[] = [];
  let oi = 0;
  let ai = 0;
  let bi = 0;

  for (;;) {
    // Scan for the next base line matched in both local and incoming.
    let sync = oi;
    while (sync < base.length) {
      const ja = matchA.get(sync);
      const jb = matchB.get(sync);
      if (ja !== undefined && ja >= ai && jb !== undefined && jb >= bi) break;
      sync += 1;
    }

    const endA = sync < base.length ? (matchA.get(sync) as number) : local.length;
    const endB = sync < base.length ? (matchB.get(sync) as number) : incoming.length;

    const oRegion = base.slice(oi, sync);
    const aRegion = local.slice(ai, endA);
    const bRegion = incoming.slice(bi, endB);

    if (aRegion.length > 0 || bRegion.length > 0) {
      if (linesEqual(aRegion, bRegion)) {
        merged.push(...aRegion); // both sides made the same change
      } else if (linesEqual(aRegion, oRegion)) {
        merged.push(...bRegion); // only incoming changed this region
      } else if (linesEqual(bRegion, oRegion)) {
        merged.push(...aRegion); // only local changed this region
      } else {
        return null; // both changed it differently → true conflict
      }
    }

    if (sync >= base.length) break;
    merged.push(base[sync]); // the stable sync line
    oi = sync + 1;
    ai = endA + 1;
    bi = endB + 1;
  }

  return merged;
}

/**
 * Format a Date as a compact, sortable UTC conflict marker `YYYYMMDD-HHmmss`.
 *
 * Pure given the Date, so the browser passes `new Date()` while tests pass a
 * fixed instant. Used to disambiguate a note's conflict copies.
 */
export function formatConflictMarker(date: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  const y = pad(date.getUTCFullYear(), 4);
  const mo = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const h = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const s = pad(date.getUTCSeconds());
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

/** The human title of a note's conflict copy: `<Title> (conflict copy <marker>)`. */
export function conflictCopyTitle(title: string, marker: string): string {
  return `${title} (conflict copy ${marker})`;
}

/** The default display title for a note identity (its frontmatter title is applied separately). */
function defaultTitle(notePath: string): string {
  const clean = normalizeNotePath(notePath);
  if (clean === "") return "Home";
  return deriveTitle(clean.slice(clean.lastIndexOf("/") + 1));
}

/** Parent identity of a note path (everything before the last `/`; root is `""`). */
function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Set the frontmatter `title` of a note's Markdown, preserving its body and other metadata. */
function withTitle(markdown: string, title: string): string {
  const doc = parseMarkdown(markdown);
  const frontmatter: Frontmatter = { ...(doc.frontmatter ?? { tags: [] }), title };
  return serializeMarkdown({ blocks: doc.blocks, frontmatter });
}

/** The sibling conflict-copy note to create, preserving the local version. */
export interface ConflictCopyPlan {
  /** Identity (tree `path`) of the new sibling conflict-copy note. */
  path: string;
  /** Repo-relative backing file of the conflict-copy note (always a leaf `.md`). */
  file: string;
  /** Display title of the copy (also written into its frontmatter). */
  title: string;
  /** Canonical Markdown stored in the copy: the local version, titled as the copy. */
  markdown: string;
}

/**
 * Plan the sibling conflict-copy note that preserves `localMarkdown`.
 *
 * The copy is a **leaf** note placed beside the original (same parent), named
 * `<title> conflict copy <marker>` (slugified into its file). Its body and tags
 * are the local version verbatim; only its frontmatter `title` is set to the
 * copy title so the nav can tell it apart from the original. Pure. When
 * `existing` note identities collide with the computed path, a `-2`, `-3`, …
 * suffix is appended (mirroring attachment collision avoidance).
 */
export function planConflictCopy(
  notePath: string,
  title: string,
  localMarkdown: string,
  marker: string,
  existing: Iterable<string> = [],
): ConflictCopyPlan {
  const copyTitle = conflictCopyTitle(title, marker);
  const parent = parentOf(normalizeNotePath(notePath));
  const baseSlug = slugifyNoteName(copyTitle) || "note-conflict-copy";

  const taken = new Set(existing);
  const candidate = (slug: string): string => (parent === "" ? slug : `${parent}/${slug}`);
  let slug = baseSlug;
  let suffix = 2;
  while (taken.has(candidate(slug))) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
  const path = candidate(slug);

  return {
    path,
    file: `${path}.md`,
    title: copyTitle,
    markdown: canonicalizeMarkdown(withTitle(localMarkdown, copyTitle)),
  };
}

/** A non-blocking notification that a conflict copy was created for a note. */
export interface ConflictNotification {
  /** Identity of the note whose sync produced a conflict. */
  notePath: string;
  /** Display title of the note. */
  noteTitle: string;
  /** Identity of the sibling conflict-copy note that now holds the local version. */
  copyPath: string;
  /** Display title of the conflict copy. */
  copyTitle: string;
  /** A short, user-facing message describing what happened. */
  message: string;
}

/** Inputs to {@link resolveNoteConflict}: a note's identity and its three versions. */
export interface ConflictInput extends ThreeWayInput {
  /** Identity (tree `path`) of the note being synced; the root note is `""`. */
  notePath: string;
  /** Display title of the note; derived from the identity when omitted. */
  title?: string;
  /** Marker disambiguating the conflict copy (e.g. {@link formatConflictMarker}). */
  marker: string;
  /** Existing note identities, so the conflict copy avoids colliding with one. */
  existing?: Iterable<string>;
}

/**
 * The decision for a note's sync: write the clean content, or keep the incoming
 * version on the note and preserve the local version as a sibling copy.
 */
export type ConflictResolution =
  | {
      status: "clean";
      /** Identity of the note. */
      notePath: string;
      /** Canonical Markdown the note should now hold (auto-merged or fast-forwarded). */
      markdown: string;
      /** Whether both sides' edits were combined (see {@link MergeResult}). */
      merged: boolean;
    }
  | {
      status: "conflict";
      /** Identity of the note. */
      notePath: string;
      /** The incoming `main` Markdown the note keeps. */
      markdown: string;
      /** The sibling conflict-copy note to create, preserving the local version. */
      copy: ConflictCopyPlan;
      /** The non-blocking notification to surface to the user. */
      notification: ConflictNotification;
    };

/**
 * Resolve a note's three-way divergence into a {@link ConflictResolution}.
 *
 * Runs {@link mergeNoteContent}; a clean merge yields the merged content for the
 * note (no copy, no notification). A true conflict keeps the incoming `main`
 * version on the note and plans a sibling {@link ConflictCopyPlan} holding the
 * local version, plus a {@link ConflictNotification}. Pure: the IO of writing it
 * is {@link applyConflictResolution}.
 */
export function resolveNoteConflict(input: ConflictInput): ConflictResolution {
  const notePath = normalizeNotePath(input.notePath);
  const title = input.title ?? defaultTitle(notePath);
  const merge = mergeNoteContent(input);

  if (merge.status === "clean") {
    return { status: "clean", notePath, markdown: merge.markdown, merged: merge.merged };
  }

  const copy = planConflictCopy(notePath, title, merge.local, input.marker, input.existing);
  const notification: ConflictNotification = {
    notePath,
    noteTitle: title,
    copyPath: copy.path,
    copyTitle: copy.title,
    message: `"${title}" had a conflicting edit — your version was saved as "${copy.title}".`,
  };
  return { status: "conflict", notePath, markdown: merge.incoming, copy, notification };
}

/** The outcome of applying a {@link ConflictResolution} through the engine. */
export interface ConflictApplication {
  /** Identity of the note. */
  notePath: string;
  /** Whether the sync was clean or produced a conflict copy. */
  status: "clean" | "conflict";
  /** The notification to surface, present only when a conflict copy was created. */
  notification?: ConflictNotification;
}

/**
 * Apply a {@link ConflictResolution} by writing through the injected
 * {@link WritableGitEngine}.
 *
 * - **clean** → write the resolved Markdown to the note's backing file.
 * - **conflict** → write the incoming version to the note, then create the
 *   sibling conflict-copy file holding the local version (two commits; the note
 *   ends on `main`'s version, the local version is never lost).
 *
 * Returns the {@link ConflictApplication}, carrying the notification when a copy
 * was created. The merge/copy decision stays pure ({@link resolveNoteConflict});
 * only the writes touch the engine.
 */
export async function applyConflictResolution(
  engine: WritableGitEngine,
  resolution: ConflictResolution,
): Promise<ConflictApplication> {
  if (resolution.status === "clean") {
    await writeNote(engine, resolution.notePath, resolution.markdown);
    return { notePath: resolution.notePath, status: "clean" };
  }

  await writeNote(engine, resolution.notePath, resolution.markdown);
  await engine.writeNoteFile(
    resolution.copy.file,
    resolution.copy.markdown,
    `Create conflict copy ${resolution.copy.path}`,
  );
  return {
    notePath: resolution.notePath,
    status: "conflict",
    notification: resolution.notification,
  };
}
