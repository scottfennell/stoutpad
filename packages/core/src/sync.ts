/**
 * `core/sync` — the autosave + wip-branch squash state machine.
 *
 * This is the runtime-agnostic heart of Stout's "continuous, crash-safe autosave
 * that still produces clean history". An **editing session** works like this:
 *
 * 1. Each edit is buffered and, after a debounce interval (~3s idle), committed
 *    onto an ephemeral local **wip branch** (`wip/<note>`) — so in-progress work
 *    survives a reload/crash as real commits.
 * 2. On **focus-leave / idle / quit** the wip branch is **squash-merged** into
 *    `main` as one meaningful commit, then deleted. So `main` shows one commit per
 *    editing session, not one per keystroke.
 *
 * The machine is a **pure state machine**: it owns no real timers and no Git. It
 * depends on an injected {@link WipSyncEngine} (real Git in the server, an HTTP
 * adapter in the browser, an in-memory fake in tests) and is driven entirely
 * through explicit methods — {@link NoteSync.onEdit}, {@link NoteSync.tick} /
 * {@link NoteSync.flush}, and the session-ending {@link NoteSync.onFocusLeave} /
 * {@link NoteSync.onIdle} / {@link NoteSync.onQuit} — so debounce and squash
 * triggers are exercised deterministically with a virtual clock. WIP branches are
 * never pushed: the seam exposes no push, and the squash only ever touches `main`.
 *
 * See `docs/adr/0004-autosave-wip-squash.md`.
 */

import { canonicalizeMarkdown } from "./markdown.js";
import { normalizeNotePath } from "./note-content.js";
import type { WritableGitEngine } from "./git-engine.js";

/** Default idle debounce before a buffered edit is committed to the wip branch. */
export const DEFAULT_DEBOUNCE_MS = 3000 as const;

/**
 * Derive the ephemeral wip branch ref for a note identity, sanitized to a valid
 * Git ref name (`git check-ref-format`).
 *
 * The result is always `wip/<slug>`: the note's tree `path` with each segment
 * stripped of characters Git forbids in a ref (whitespace, `~^:?*[\`, control
 * chars, `..`, leading/trailing dots, a `.lock` suffix). The root note (`""`)
 * maps to `wip/root`. Pure and deterministic so the server and client always
 * compute the same ref for the same note.
 */
export function wipBranchName(notePath: string): string {
  const clean = normalizeNotePath(notePath);
  const slug = clean
    .split("/")
    .map(sanitizeRefSegment)
    .filter((segment) => segment.length > 0)
    .join("/");
  return `wip/${slug === "" ? "root" : slug}`;
}

function sanitizeRefSegment(segment: string): string {
  return segment
    .replace(/[\u0000-\u0020~^:?*[\]\\]/gu, "-") // ref-forbidden chars → dash
    .replace(/\.lock$/iu, "-lock") // a ref component may not end with .lock
    .replace(/\.{2,}/gu, "-") // no ".." in a ref
    .replace(/-{2,}/gu, "-") // collapse dash runs
    .replace(/^[.\-]+|[.\-]+$/gu, ""); // no leading/trailing dot or dash
}

/**
 * The wip-branch operations the {@link NoteSync} state machine drives.
 *
 * Deliberately narrow — just the ephemeral-branch lifecycle — so the browser can
 * implement it as a thin HTTP adapter and tests can fake it, while the server's
 * full {@link WipGitEngine} layers it on top of commit-on-save. There is no push
 * operation here by design: wip branches are local-only and never pushed.
 */
export interface WipSyncEngine {
  /** Ref name of the note's wip branch (see {@link wipBranchName}). */
  wipBranchName(notePath: string): string;
  /**
   * Commit `markdown` (already canonical) onto the note's wip branch, creating
   * the branch from `main` on the first commit of a session and appending to it
   * thereafter. Implementations should skip a commit that changes nothing.
   */
  commitToWip(notePath: string, markdown: string): Promise<void>;
  /**
   * Squash-merge the note's wip branch into `main` as a single commit with
   * `message` (a no-op if the wip branch holds no net change vs `main`).
   */
  squashMergeWipToMain(notePath: string, message: string): Promise<void>;
  /** Delete the note's wip branch (idempotent if it does not exist). */
  deleteWip(notePath: string): Promise<void>;
}

/**
 * A {@link WritableGitEngine} that also supports the wip-branch lifecycle. The
 * Node engine implements this; the pure {@link NoteSync} only needs the narrower
 * {@link WipSyncEngine} slice.
 */
export interface WipGitEngine extends WritableGitEngine, WipSyncEngine {}

/** A virtual clock, injected so debounce timing is deterministic in tests. */
export interface SyncClock {
  /** Current time in milliseconds (monotonic for the machine's purposes). */
  now(): number;
}

const systemClock: SyncClock = { now: () => Date.now() };

/** Phase of an editing session. */
export type SyncPhase =
  /** No buffered edit and no wip commits — nothing to do. */
  | "idle"
  /** An edit is buffered but the debounce interval has not yet elapsed. */
  | "pending"
  /** At least one wip commit exists this session, awaiting a squash. */
  | "wip";

/** A snapshot of a {@link NoteSync}'s state (for the UI and assertions). */
export interface SyncStatus {
  /** Identity (tree `path`) of the note this session edits. */
  notePath: string;
  /** Current {@link SyncPhase}. */
  phase: SyncPhase;
  /** Whether a buffered edit is awaiting its debounce flush. */
  hasPendingEdit: boolean;
  /** Number of wip commits made in the current session. */
  wipCommits: number;
  /** Ref name of the note's wip branch. */
  wipBranch: string;
}

/** Construction options for a {@link NoteSync}. */
export interface NoteSyncOptions {
  /** Idle debounce before a buffered edit is committed to wip (ms). */
  debounceMs?: number;
  /** Injected clock; defaults to wall-clock time. */
  clock?: SyncClock;
  /**
   * The note's current canonical Markdown when the session starts, used to dedupe
   * no-op edits (typing then reverting commits nothing). Optional.
   */
  initialMarkdown?: string;
  /** Build the squash commit message for a session; overridable. */
  buildMessage?: (notePath: string) => string;
}

/** Default squash commit message for an editing session. */
export function defaultSessionMessage(notePath: string): string {
  const clean = normalizeNotePath(notePath);
  return `Edit ${clean === "" ? "root note" : clean}`;
}

/**
 * The autosave + squash state machine for a single note's editing session.
 *
 * Drive it from the host: call {@link onEdit} on every editor change, advance the
 * debounce with {@link tick} (or force it with {@link flush}), and end the session
 * with {@link onFocusLeave} / {@link onIdle} / {@link onQuit}. The machine
 * canonicalizes each edit, coalesces keystrokes into wip commits, and squashes the
 * session into exactly one `main` commit — idempotently, so a redundant
 * session-end (e.g. blur then quit) does nothing.
 */
export class NoteSync {
  private readonly engine: WipSyncEngine;
  private readonly debounceMs: number;
  private readonly clock: SyncClock;
  private readonly buildMessage: (notePath: string) => string;

  /** The note identity this session edits. */
  readonly notePath: string;

  /** Latest buffered edit not yet committed to wip, or `null` when none. */
  private pending: string | null = null;
  /** Clock time of the most recent buffered edit (debounce reference). */
  private dirtySince = 0;
  /** Last canonical content known to be persisted (wip or main); dedupes no-ops. */
  private lastCommitted: string | null;
  /** Wip commits made during the current session (>0 ⇒ a squash is owed). */
  private wipCommits = 0;

  constructor(engine: WipSyncEngine, notePath: string, options: NoteSyncOptions = {}) {
    this.engine = engine;
    this.notePath = normalizeNotePath(notePath);
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.clock = options.clock ?? systemClock;
    this.buildMessage = options.buildMessage ?? defaultSessionMessage;
    this.lastCommitted =
      options.initialMarkdown === undefined
        ? null
        : canonicalizeMarkdown(options.initialMarkdown);
  }

  /** A snapshot of the current state, for the UI and for test assertions. */
  get status(): SyncStatus {
    return {
      notePath: this.notePath,
      phase: this.phase,
      hasPendingEdit: this.pending !== null,
      wipCommits: this.wipCommits,
      wipBranch: this.engine.wipBranchName(this.notePath),
    };
  }

  private get phase(): SyncPhase {
    if (this.pending !== null) return "pending";
    if (this.wipCommits > 0) return "wip";
    return "idle";
  }

  /**
   * Record an editor change. The Markdown is buffered (not yet committed) and the
   * debounce timer is (re)started; call {@link tick}/{@link flush} to commit it.
   */
  onEdit(markdown: string): void {
    this.pending = markdown;
    this.dirtySince = this.clock.now();
  }

  /**
   * Advance the virtual clock. If a buffered edit has been idle for at least the
   * debounce interval, commit it to the wip branch. `nowMs` defaults to the
   * injected clock, so tests can drive timing either by mutating the clock or by
   * passing the time explicitly.
   */
  async tick(nowMs: number = this.clock.now()): Promise<void> {
    if (this.pending === null) return;
    if (nowMs - this.dirtySince >= this.debounceMs) {
      await this.commitPendingToWip();
    }
  }

  /**
   * Force any buffered edit to the wip branch immediately, ignoring the debounce.
   * Used by the host's real debounce timer and as a pre-squash safety net.
   */
  async flush(): Promise<void> {
    await this.commitPendingToWip();
  }

  /**
   * End the editing session because focus left the note (tab blur, switching
   * notes): flush any buffered edit to wip, then squash-merge the session into
   * `main` and delete the wip branch. Idempotent — a session with no wip commits
   * does nothing.
   */
  async onFocusLeave(message?: string): Promise<void> {
    await this.endSession(message);
  }

  /** End the session because the editor went idle (idle safety net). */
  async onIdle(message?: string): Promise<void> {
    await this.endSession(message);
  }

  /** End the session because the app is quitting/unloading (quit safety net). */
  async onQuit(message?: string): Promise<void> {
    await this.endSession(message);
  }

  private async commitPendingToWip(): Promise<void> {
    if (this.pending === null) return;
    const canonical = canonicalizeMarkdown(this.pending);
    this.pending = null;
    // Dedupe: an edit that canonicalizes to the last persisted content is a no-op,
    // so it never creates an empty wip commit.
    if (canonical === this.lastCommitted) return;
    await this.engine.commitToWip(this.notePath, canonical);
    this.lastCommitted = canonical;
    this.wipCommits += 1;
  }

  private async endSession(message?: string): Promise<void> {
    // Pre-sync safety net: never leave a buffered edit unsynced.
    await this.commitPendingToWip();
    if (this.wipCommits === 0) {
      // Nothing to squash this session. Crucially we do NOT delete any branch
      // here: a wip branch we did not create (e.g. an orphan from a prior crash)
      // must survive to be squashed by a later editing session, not silently lost.
      return;
    }
    await this.engine.squashMergeWipToMain(
      this.notePath,
      message ?? this.buildMessage(this.notePath),
    );
    await this.engine.deleteWip(this.notePath);
    this.wipCommits = 0;
  }
}

/** REST path of the note autosave/squash endpoint (`POST` only). */
export const SYNC_PATH = "/api/note/sync" as const;

/**
 * What a {@link NoteSyncRequest} asks the server to do — one thin wip-branch op
 * each, so the client's {@link NoteSync} stays the orchestrator:
 * - `autosave`: commit the edit onto the note's wip branch.
 * - `squash`: squash-merge the wip branch into `main`.
 * - `delete-wip`: delete the wip branch.
 */
export type SyncAction = "autosave" | "squash" | "delete-wip";

/** Request body of `POST /api/note/sync`. */
export interface NoteSyncRequest {
  /** Identity (tree `path`) of the note; the root note is `""`. */
  path: string;
  /** The wip-branch operation to perform. */
  action: SyncAction;
  /** Edited Markdown (required for `autosave`; canonicalized server-side). */
  markdown?: string;
  /** Squash commit message (optional for `squash`; a default is used otherwise). */
  message?: string;
}

/** Response body of `POST /api/note/sync`. */
export interface NoteSyncResponse {
  /** Identity (tree `path`) of the note. */
  path: string;
  /** The action that was performed. */
  action: SyncAction;
  /** Ref name of the note's wip branch (never a pushed ref). */
  wipBranch: string;
}

/**
 * Apply a {@link NoteSyncRequest} against a {@link WipSyncEngine} — the server's
 * counterpart to the client's {@link NoteSync} orchestrator. Each action maps to
 * exactly one wip-branch operation:
 * - `autosave` → {@link WipSyncEngine.commitToWip} (canonicalizing the Markdown,
 *   which must be present);
 * - `squash` → {@link WipSyncEngine.squashMergeWipToMain} (defaulting the commit
 *   message via {@link defaultSessionMessage});
 * - `delete-wip` → {@link WipSyncEngine.deleteWip}.
 *
 * Pure but for the injected engine, mirroring `readNote`/`writeNote`: the HTTP
 * layer just validates and delegates here. Throws on an `autosave` without
 * Markdown so the route can surface a 400.
 */
export async function applyNoteSync(
  engine: WipSyncEngine,
  request: NoteSyncRequest,
): Promise<NoteSyncResponse> {
  const path = normalizeNotePath(request.path);
  const wipBranch = engine.wipBranchName(path);
  switch (request.action) {
    case "autosave": {
      if (typeof request.markdown !== "string") {
        throw new Error("markdown is required for the autosave action");
      }
      await engine.commitToWip(path, canonicalizeMarkdown(request.markdown));
      break;
    }
    case "squash": {
      await engine.squashMergeWipToMain(
        path,
        request.message ?? defaultSessionMessage(path),
      );
      break;
    }
    case "delete-wip": {
      await engine.deleteWip(path);
      break;
    }
    default: {
      const invalid: never = request.action;
      throw new Error(`unknown sync action: ${String(invalid)}`);
    }
  }
  return { path, action: request.action, wipBranch };
}
