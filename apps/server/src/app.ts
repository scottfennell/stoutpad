import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import express, { type Express } from "express";
import {
  HEALTH_PATH,
  NOTE_PATH,
  SYNC_PATH,
  TREE_PATH,
  type HealthStatus,
  type NoteContentResponse,
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
  /** Absolute path to the built UI assets. Omit to skip static hosting. */
  uiDir?: string;
}

/** Whether `value` is one of the three valid wip-branch sync actions. */
function isSyncAction(value: unknown): value is SyncAction {
  return value === "autosave" || value === "squash" || value === "delete-wip";
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

  if (deps.uiDir) {
    app.use(express.static(deps.uiDir));
    // SPA fallback for client-side routes (but never for the API).
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(join(deps.uiDir!, "index.html"));
    });
  }

  return app;
}
