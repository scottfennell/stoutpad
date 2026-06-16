import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import express, { type Express, type Response } from "express";
import {
  HEALTH_PATH,
  LINKS_PATH,
  NOTE_CREATE_PATH,
  NOTE_MOVE_PATH,
  NOTE_PATH,
  NOTE_RENAME_PATH,
  NoteMutationError,
  SYNC_PATH,
  TREE_PATH,
  type HealthStatus,
  type LinkGraphResponse,
  type NoteContentResponse,
  type NoteCreateRequest,
  type NoteMoveRequest,
  type NoteMutationResponse,
  type NoteRenameRequest,
  type NoteSaveRequest,
  type NoteSyncRequest,
  type NoteSyncResponse,
  type NoteTreeResponse,
  type SyncAction,
} from "@stout/core";

export interface AppDeps {
  /** Produce the current health status (injected so it can be faked in tests). */
  getHealth: () => Promise<HealthStatus>;
  /**
   * Produce the unified note tree. Injected so HTTP behavior is tested without a
   * real repo. Omit to skip mounting the tree endpoint.
   */
  getTree?: () => Promise<NoteTreeResponse>;
  /**
   * Produce the note link graph (`[[wikilinks]]` between notes, plus broken
   * links). Injected so HTTP behavior is tested without a real repo. Omit to skip
   * mounting the links endpoint.
   */
  getLinks?: () => Promise<LinkGraphResponse>;
  /**
   * Read a single note's content by identity (tree `path`), or resolve to `null`
   * when the note is missing (mapped to a 404). Injected so HTTP behavior is
   * tested without a real repo. Omit to skip mounting the note endpoint.
   */
  getNote?: (path: string) => Promise<NoteContentResponse | null>;
  /**
   * Persist a note's edited Markdown by identity (tree `path`), returning the
   * saved note with its canonical Markdown. Injected so HTTP behavior is tested
   * without a real repo. Omit to skip mounting the save endpoint.
   */
  saveNote?: (path: string, markdown: string) => Promise<NoteContentResponse>;
  /**
   * Apply one wip-branch sync action (autosave / squash / delete-wip) for the
   * autosave state machine, returning the action's result. Injected so HTTP
   * behavior is tested without a real repo. Omit to skip mounting the sync
   * endpoint.
   */
  syncNote?: (request: NoteSyncRequest) => Promise<NoteSyncResponse>;
  /**
   * Create a new leaf note named `name` under the `parent` note (promoting the
   * parent from a leaf if needed), returning the new note's identity. Injected so
   * HTTP behavior is tested without a real repo. Omit to skip the endpoint.
   */
  createNote?: (parent: string, name: string) => Promise<NoteMutationResponse>;
  /**
   * Rename a note in place (moving its whole subtree if it is a parent),
   * returning the note's new identity. Omit to skip the endpoint.
   */
  renameNote?: (path: string, name: string) => Promise<NoteMutationResponse>;
  /**
   * Move a note under a different `parent` (promoting/collapsing as needed),
   * returning the note's new identity. Omit to skip the endpoint.
   */
  moveNote?: (path: string, parent: string) => Promise<NoteMutationResponse>;
  /** Absolute path to the built UI assets. Omit to skip static hosting. */
  uiDir?: string;
}

/** Whether `value` is one of the three valid wip-branch sync actions. */
function isSyncAction(value: unknown): value is SyncAction {
  return value === "autosave" || value === "squash" || value === "delete-wip";
}

/**
 * Run a note mutation and send its result, mapping a {@link NoteMutationError}
 * (invalid name, duplicate target, illegal move) to a 400 client error and any
 * other failure to a 500 — mirroring the read/write routes' error handling.
 */
async function respondMutation(
  res: Response,
  run: () => Promise<NoteMutationResponse>,
): Promise<void> {
  try {
    res.json(await run());
  } catch (err) {
    if (err instanceof NoteMutationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

/** Resolve the directory holding the built `@stout/ui` SPA assets. */
export function resolveUiDir(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("@stout/ui/package.json");
  return join(dirname(pkg), "dist");
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.get(HEALTH_PATH, async (_req, res) => {
    try {
      const health = await deps.getHealth();
      res.status(health.status === "ok" ? 200 : 503).json(health);
    } catch (err) {
      res.status(503).json({
        status: "degraded",
        service: "stout",
        database: false,
        migration: 0,
        timestamp: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  if (deps.getTree) {
    const getTree = deps.getTree;
    app.get(TREE_PATH, async (_req, res) => {
      try {
        res.json(await getTree());
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  if (deps.getLinks) {
    const getLinks = deps.getLinks;
    // `GET /api/links` returns the whole note link graph (resolved edges + broken
    // links). Read-only, like the tree endpoint.
    app.get(LINKS_PATH, async (_req, res) => {
      try {
        res.json(await getLinks());
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  if (deps.getNote) {
    const getNote = deps.getNote;
    app.get(NOTE_PATH, async (req, res) => {
      // The root note has the empty-string identity, so a missing/odd `path`
      // query degrades to the root rather than erroring.
      const path = typeof req.query.path === "string" ? req.query.path : "";
      try {
        const note = await getNote(path);
        if (!note) {
          res.status(404).json({ error: `note not found: ${path}` });
          return;
        }
        res.json(note);
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  if (deps.saveNote) {
    const saveNote = deps.saveNote;
    // `POST /api/note` saves an edited note. The body is the note's identity plus
    // its Markdown; the engine canonicalizes and commits it to `main`.
    app.post(NOTE_PATH, express.json({ limit: "5mb" }), async (req, res) => {
      const body = (req.body ?? {}) as Partial<NoteSaveRequest>;
      // The root note has the empty-string identity, so a missing `path` saves it.
      const path = typeof body.path === "string" ? body.path : "";
      if (typeof body.markdown !== "string") {
        res.status(400).json({ error: "markdown (string) is required" });
        return;
      }
      try {
        res.json(await saveNote(path, body.markdown));
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  if (deps.syncNote) {
    const syncNote = deps.syncNote;
    // `POST /api/note/sync` drives one wip-branch operation per request: commit a
    // debounced edit to the note's wip branch (`autosave`), squash that branch
    // into `main` (`squash`), or delete it (`delete-wip`). The client's NoteSync
    // stays the orchestrator; the server just performs the requested atomic step.
    app.post(SYNC_PATH, express.json({ limit: "5mb" }), async (req, res) => {
      const body = (req.body ?? {}) as Partial<NoteSyncRequest>;
      // The root note has the empty-string identity, so a missing `path` targets it.
      const path = typeof body.path === "string" ? body.path : "";
      if (!isSyncAction(body.action)) {
        res
          .status(400)
          .json({ error: "action must be one of: autosave, squash, delete-wip" });
        return;
      }
      if (body.action === "autosave" && typeof body.markdown !== "string") {
        res.status(400).json({ error: "markdown (string) is required for autosave" });
        return;
      }
      try {
        res.json(
          await syncNote({
            path,
            action: body.action,
            markdown: body.markdown,
            message: body.message,
          }),
        );
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  if (deps.createNote) {
    const createNote = deps.createNote;
    // `POST /api/note/create` creates a new leaf note under `parent`, promoting
    // the parent from a leaf to a directory note when it gains its first child.
    app.post(NOTE_CREATE_PATH, express.json({ limit: "1mb" }), async (req, res) => {
      const body = (req.body ?? {}) as Partial<NoteCreateRequest>;
      const parent = typeof body.parent === "string" ? body.parent : "";
      if (typeof body.name !== "string" || body.name.trim() === "") {
        res.status(400).json({ error: "name (non-empty string) is required" });
        return;
      }
      await respondMutation(res, () => createNote(parent, body.name as string));
    });
  }

  if (deps.renameNote) {
    const renameNote = deps.renameNote;
    // `POST /api/note/rename` renames a note in place (whole subtree for a parent).
    app.post(NOTE_RENAME_PATH, express.json({ limit: "1mb" }), async (req, res) => {
      const body = (req.body ?? {}) as Partial<NoteRenameRequest>;
      if (typeof body.path !== "string" || body.path === "") {
        res.status(400).json({ error: "path (non-empty string) is required" });
        return;
      }
      if (typeof body.name !== "string" || body.name.trim() === "") {
        res.status(400).json({ error: "name (non-empty string) is required" });
        return;
      }
      await respondMutation(res, () =>
        renameNote(body.path as string, body.name as string),
      );
    });
  }

  if (deps.moveNote) {
    const moveNote = deps.moveNote;
    // `POST /api/note/move` moves a note under a different parent. The destination
    // `parent` defaults to the root note when absent.
    app.post(NOTE_MOVE_PATH, express.json({ limit: "1mb" }), async (req, res) => {
      const body = (req.body ?? {}) as Partial<NoteMoveRequest>;
      const parent = typeof body.parent === "string" ? body.parent : "";
      if (typeof body.path !== "string" || body.path === "") {
        res.status(400).json({ error: "path (non-empty string) is required" });
        return;
      }
      await respondMutation(res, () => moveNote(body.path as string, parent));
    });
  }

  if (deps.uiDir) {
    app.use(express.static(deps.uiDir));
    // SPA fallback for client-side routes (but never for the API).
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(join(deps.uiDir!, "index.html"));
    });
  }

  return app;
}
