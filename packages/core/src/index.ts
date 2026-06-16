/**
 * Shared, runtime-agnostic domain contracts for Stout.
 *
 * Carries the health-check contract (walking skeleton) plus the note domain: the
 * pure file-set → tree mapper, the pure create/rename/move mutation planner
 * (incl. the leaf↔parent transition), the git-engine read/write seam
 * (`GET /api/tree`, `GET`/`POST /api/note`, create/rename/move endpoints), the
 * pure `core/markdown` parser/serializer, the `core/sync` autosave +
 * wip-branch squash state machine (`POST /api/note/sync`), the
 * `core/sync-cadence` sync scheduler (launch/reconnect/focus/timer/manual) and
 * the `core/conflict` multi-device merge policy (auto-merge + keep-both copy), the
 * `core/wikilink` title resolver + link graph (`GET /api/links`), the
 * `core/attachment` embedded-media contract (`POST /api/attachment`), the
 * pure `core/search-index` core (chunking, the Embedder/VectorStore seams,
 * cosine ranking + keyword fallback) behind `GET /api/search`, and the
 * local-first desktop seams: `core/token-store` (the secret-at-rest TokenStore +
 * SecureStorage/SecureFilePorts seams) and `core/hub-sync` (the pure
 * clone-then-sync orchestrator + token-in-URL credential maths).
 * Everything here is runtime-agnostic — the Node/Git and editor (DOM)
 * implementations live in `apps/server` and `packages/ui`.
 */

export * from "./note-tree.js";
export * from "./note-content.js";
export * from "./note-mutation.js";
export * from "./git-engine.js";
export * from "./markdown.js";
export * from "./sync.js";
export * from "./sync-cadence.js";
export * from "./conflict.js";
export * from "./wikilink.js";
export * from "./attachment.js";
export * from "./search-index.js";
export * from "./token-store.js";
export * from "./hub-sync.js";

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
