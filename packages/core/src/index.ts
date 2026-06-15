/**
 * Shared, runtime-agnostic domain contracts for Stout.
 *
 * Carries the health-check contract (walking skeleton) plus the note-tree
 * domain: the pure file-set → tree mapper, the git-engine read seam, and the
 * `GET /api/tree` contract. Everything here is runtime-agnostic — the Node/Git
 * implementations live in `apps/server`.
 */

export * from "./note-tree.js";
export * from "./git-engine.js";

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
