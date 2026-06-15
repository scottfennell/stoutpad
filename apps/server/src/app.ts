import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import express, { type Express } from "express";
import {
  HEALTH_PATH,
  NOTE_PATH,
  TREE_PATH,
  type HealthStatus,
  type NoteContentResponse,
  type NoteTreeResponse,
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
  /** Absolute path to the built UI assets. Omit to skip static hosting. */
  uiDir?: string;
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

  if (deps.uiDir) {
    app.use(express.static(deps.uiDir));
    // SPA fallback for client-side routes (but never for the API).
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(join(deps.uiDir!, "index.html"));
    });
  }

  return app;
}
