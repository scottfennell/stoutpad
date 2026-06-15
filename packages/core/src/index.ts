/**
 * Shared, runtime-agnostic domain contracts for Stout.
 *
 * Carries the health-check contract (walking skeleton) plus the note domain: the
 * pure file-set → tree mapper, the git-engine read/write seam (`GET /api/tree`,
 * `GET`/`POST /api/note`), the pure `core/markdown` parser/serializer, and the
 * `core/sync` autosave + wip-branch squash state machine (`POST /api/note/sync`).
 * Everything here is runtime-agnostic — the Node/Git and editor (DOM)
 * implementations live in `apps/server` and `packages/ui`.
 */

export * from "./note-tree.js";
export * from "./note-content.js";
export * from "./git-engine.js";
export * from "./markdown.js";
export * from "./sync.js";

/** Health status reported by the server's `/api/health` endpoint. */
export interface HealthStatus {
  /** Overall service status. */
  status: "ok" | "degraded";
  /** Service identifier. */
  service: "stout";
  /** Whether the dedicated `stout` database is reachable. */
  database: boolean;
  /** Highest migration version that has been applied. */
  migration: number;
  /** Server time the check was produced (ISO 8601). */
  timestamp: string;
}

export const HEALTH_PATH = "/api/health" as const;
