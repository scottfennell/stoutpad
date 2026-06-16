/**
 * `core/remote-sync` — the runtime-agnostic policy for syncing the server's
 * `main` with a configurable **external remote** (e.g. a GitHub repo).
 *
 * Stout's server is normally the source of truth: it owns an internal bare repo
 * and clients talk only to it. This module lets that be reconfigured so the
 * server's working clone instead tracks an **external** Git remote that *other
 * actors can also write to* — while the server stays the sync hub the clients see.
 * Because the external history can diverge from `main`, the server cannot simply
 * fast-forward; it must **merge at that boundary**. Crucially, it merges using the
 * very same `core/conflict` policy the multi-device story uses
 * ({@link resolveNoteConflict}), so a non-overlapping external edit auto-merges and
 * a true conflict keeps **both** versions (incoming on the note, the local version
 * as a sibling conflict copy) — zero data loss.
 *
 * The split mirrors the rest of `core`:
 * - {@link reconcileNotesWithIncoming} is the **pure** heart — given each changed
 *   note's three versions (base / local / incoming) it produces the
 *   {@link ConflictResolution}s to apply and the {@link ConflictNotification}s to
 *   surface, by deferring to {@link resolveNoteConflict} per note.
 * - {@link syncRemoteBoundary} is the orchestrator: fetch the external branch,
 *   assemble the three-way inputs over the narrow {@link RemoteBoundaryEngine}
 *   seam, reconcile, apply each resolution to `main`, record a merge so the push
 *   is a fast-forward, then push. The token is read from a {@link TokenStore} and
 *   injected into the URL only for the Git ops (never returned/logged/persisted),
 *   reusing the `core/hub-sync` credential maths.
 *
 * The actual `git` shelling lives in `apps/server` (`remote-engine.ts`); this
 * stays pure so the boundary-merge policy is unit-tested against an in-memory
 * fake with no network. Clients are entirely unaware any of this happens.
 *
 * See `docs/adr/0012-external-remote-and-server-boundary-merge.md`.
 */

import {
  applyConflictResolution,
  formatConflictMarker,
  resolveNoteConflict,
  type ConflictNotification,
  type ConflictResolution,
} from "./conflict.js";
import { canonicalizeMarkdown, parseFrontmatter } from "./markdown.js";
import { authenticateRemoteUrl } from "./hub-sync.js";
import { noteIdentityForFile, normalizeNotePath } from "./note-content.js";
import type { WritableGitEngine } from "./git-engine.js";
import type { TokenStore } from "./token-store.js";

/** Default external branch synced when a {@link RemoteConfig} does not name one. */
export const DEFAULT_REMOTE_BRANCH = "main" as const;

/** How to reach the external remote: its URL and (optionally) the branch to sync. */
export interface RemoteConfig {
  /** The external remote's Git URL (HTTPS in production; any Git URL works). */
  remoteUrl: string;
  /** Branch to sync; defaults to {@link DEFAULT_REMOTE_BRANCH}. */
  branch?: string;
}

/** One changed note's three versions, as canonical-or-raw Markdown (or `null` if absent). */
export interface BoundaryNote {
  /** Identity (tree `path`) of the note; the root note is `""`. */
  notePath: string;
  /** Display title used to name a conflict copy; derived from identity when omitted. */
  title?: string;
  /** Markdown at the merge base, or `null` when the note did not exist there. */
  base: string | null;
  /** Markdown on local `main`, or `null` when the note does not exist locally. */
  local: string | null;
  /** Markdown on the incoming external ref, or `null` when absent there. */
  incoming: string | null;
}

/** Options controlling {@link reconcileNotesWithIncoming}. */
export interface ReconcileOptions {
  /** Marker disambiguating conflict copies (e.g. {@link formatConflictMarker}). */
  marker: string;
  /** Existing note identities so a conflict copy avoids colliding with one. */
  existing?: Iterable<string>;
}

/** The decisions {@link reconcileNotesWithIncoming} produced for a sync. */
export interface BoundaryReconciliation {
  /** Per-note resolutions to apply to `main` (clean writes / conflict copies). */
  resolutions: ConflictResolution[];
  /** Non-blocking notifications for notes that produced a conflict copy. */
  notifications: ConflictNotification[];
}

/**
 * Reconcile each changed note's three versions into the resolutions to apply and
 * the notifications to surface — the pure boundary-merge policy.
 *
 * Per note (keyed by identity):
 * - **incoming absent** → the external side does not have it; keep local, emit
 *   nothing (external deletions are not propagated — a deliberate no-data-loss
 *   choice, see the ADR).
 * - **local absent** → the external side added it; adopt it (clean).
 * - **already equal** (canonically) → nothing to do.
 * - **both present and differing** → defer to {@link resolveNoteConflict}: a
 *   non-overlapping three-way auto-merges (clean), a true overlap keeps the
 *   incoming version on the note and preserves the local version as a sibling
 *   conflict copy (with a {@link ConflictNotification}).
 *
 * A missing `base` is treated as the empty ancestor (`""`), so two independent
 * creations of the same identity reconcile as a conflict (keep both) rather than
 * silently clobbering one. Conflict copies are de-duplicated against `existing`
 * plus every identity seen here and every copy already planned this round. Pure.
 */
export function reconcileNotesWithIncoming(
  notes: readonly BoundaryNote[],
  options: ReconcileOptions,
): BoundaryReconciliation {
  const resolutions: ConflictResolution[] = [];
  const notifications: ConflictNotification[] = [];

  // Conflict copies must avoid colliding with any note that exists on either side.
  const existing = new Set<string>(options.existing ?? []);
  for (const note of notes) {
    if (note.local !== null || note.incoming !== null) {
      existing.add(normalizeNotePath(note.notePath));
    }
  }

  for (const note of notes) {
    if (note.incoming === null) continue; // external lacks it → keep local
    if (note.local === null) {
      // External added it → adopt the incoming version verbatim.
      resolutions.push({
        status: "clean",
        notePath: normalizeNotePath(note.notePath),
        markdown: canonicalizeMarkdown(note.incoming),
        merged: false,
      });
      continue;
    }
    if (canonicalizeMarkdown(note.local) === canonicalizeMarkdown(note.incoming)) {
      continue; // already in sync
    }

    const resolution = resolveNoteConflict({
      notePath: note.notePath,
      title: note.title,
      base: note.base ?? "",
      local: note.local,
      incoming: note.incoming,
      marker: options.marker,
      existing,
    });
    resolutions.push(resolution);
    if (resolution.status === "conflict") {
      notifications.push(resolution.notification);
      existing.add(resolution.copy.path); // don't let two copies collide this round
    }
  }

  return { resolutions, notifications };
}

/** The fetched external tip and the merge base it shares with local `main`. */
export interface BoundaryFetch {
  /** Opaque ref (a commit sha) of the fetched external branch tip. */
  ref: string;
  /** Merge base of local `main` and {@link ref}, or `null` when there is none. */
  baseRef: string | null;
}

/**
 * The Git operations {@link syncRemoteBoundary} drives against the external
 * remote, on top of the {@link WritableGitEngine} reads/writes it uses for `main`.
 *
 * Deliberately narrow so the Node side is a thin `git` shell and tests fake it.
 * Each method that takes an `authenticatedUrl` receives the token baked in for
 * that single call; implementations must not persist it.
 */
export interface RemoteBoundaryEngine extends WritableGitEngine {
  /**
   * Fetch `branch` from the external remote and report its tip + the merge base
   * with local `main`. Resolves `null` when the remote does not have `branch`
   * yet (an empty remote), so the caller seeds it by pushing.
   */
  fetchBoundary(authenticatedUrl: string, branch: string): Promise<BoundaryFetch | null>;
  /** Repo-relative `.md` files that differ between `fromRef` and `toRef`. */
  changedNoteFiles(fromRef: string, toRef: string): Promise<string[]>;
  /** Read a file's content at a specific ref, or `null` when absent there. */
  readFileAt(ref: string, file: string): Promise<string | null>;
  /**
   * Record a merge of `ref` into `main` that **keeps the current (reconciled)
   * tree** and only adds `ref` as a second parent, so the subsequent push is a
   * fast-forward. A no-op when `ref` is already an ancestor of `main`.
   */
  recordBoundaryMerge(ref: string, message: string): Promise<void>;
  /** Push local `main` to the external remote's `branch`. */
  pushBoundary(authenticatedUrl: string, branch: string): Promise<void>;
}

/** What {@link syncRemoteBoundary} did this run. */
export interface RemoteSyncResult {
  /** `publish` when seeding an empty remote, `sync` when a real sync ran. */
  action: "publish" | "sync";
  /** The branch that was synced. */
  branch: string;
  /** Identities of notes whose external changes were cleanly merged/adopted. */
  merged: string[];
  /** Notifications for notes that produced a conflict copy (kept both versions). */
  conflicts: ConflictNotification[];
}

/** Options for {@link syncRemoteBoundary}. */
export interface RemoteSyncOptions {
  /** Marker for conflict copies; defaults to {@link formatConflictMarker} of now. */
  marker?: string;
  /** Commit message for the boundary merge; has a sensible default. */
  mergeMessage?: string;
}

/**
 * Synchronise local `main` with the external remote, merging divergent history at
 * the boundary with the `core/conflict` policy.
 *
 * 1. Read the token and authenticate the URL ({@link authenticateRemoteUrl}).
 * 2. {@link RemoteBoundaryEngine.fetchBoundary fetch} the branch. An empty remote
 *    (no such branch) → just push to seed it (`publish`).
 * 3. For every note file that differs between `main` and the fetched tip, gather
 *    its base/local/incoming Markdown and {@link reconcileNotesWithIncoming}.
 * 4. {@link applyConflictResolution Apply} each resolution to `main` (clean writes
 *    and any conflict copies).
 * 5. {@link RemoteBoundaryEngine.recordBoundaryMerge Record} the merge so `main`
 *    descends from the external tip, then
 *    {@link RemoteBoundaryEngine.pushBoundary push}.
 *
 * Pure but for the injected store and engine. The token is materialised into a URL
 * only for the fetch/push and never returned, logged, or persisted.
 */
export async function syncRemoteBoundary(
  engine: RemoteBoundaryEngine,
  tokenStore: TokenStore,
  config: RemoteConfig,
  options: RemoteSyncOptions = {},
): Promise<RemoteSyncResult> {
  const branch = config.branch ?? DEFAULT_REMOTE_BRANCH;
  const token = await tokenStore.get();
  const url = authenticateRemoteUrl(config.remoteUrl, token);

  const fetched = await engine.fetchBoundary(url, branch);
  if (fetched === null) {
    // Empty remote: publish local `main` to seed the branch.
    await engine.pushBoundary(url, branch);
    return { action: "publish", branch, merged: [], conflicts: [] };
  }

  // Assemble the three-way inputs for every changed note (deduped by identity).
  const changed = await engine.changedNoteFiles("HEAD", fetched.ref);
  const notes: BoundaryNote[] = [];
  const seen = new Set<string>();
  for (const file of changed) {
    const notePath = noteIdentityForFile(file);
    if (seen.has(notePath)) continue;
    seen.add(notePath);

    const local = await engine.readNoteFile(file);
    const incoming = await engine.readFileAt(fetched.ref, file);
    const base = fetched.baseRef === null ? null : await engine.readFileAt(fetched.baseRef, file);
    notes.push({ notePath, title: titleOf(local ?? incoming), base, local, incoming });
  }

  const existing = (await engine.listNoteFiles()).map((f) => noteIdentityForFile(f.path));
  const marker = options.marker ?? formatConflictMarker(new Date());
  const { resolutions, notifications } = reconcileNotesWithIncoming(notes, { marker, existing });

  const merged: string[] = [];
  for (const resolution of resolutions) {
    await applyConflictResolution(engine, resolution);
    if (resolution.status === "clean") merged.push(resolution.notePath);
  }

  await engine.recordBoundaryMerge(
    fetched.ref,
    options.mergeMessage ?? `Merge external remote ${branch}`,
  );
  await engine.pushBoundary(url, branch);

  return { action: "sync", branch, merged, conflicts: notifications };
}

/** A note's frontmatter `title`, when its Markdown declares one. */
function titleOf(markdown: string | null): string | undefined {
  if (markdown === null) return undefined;
  return parseFrontmatter(markdown).frontmatter?.title;
}
