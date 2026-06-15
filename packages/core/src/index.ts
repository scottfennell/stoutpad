/**
 * Shared, runtime-agnostic domain contracts for Stout.
 *
 * For the walking skeleton this only carries the health-check contract that the
 * server returns and the UI renders, proving the core package wires into both
 * the server and browser runtimes unchanged.
 */

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
