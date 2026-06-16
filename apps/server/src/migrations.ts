import type { Migration } from "./migrate.js";

/**
 * Ordered list of schema migrations for the dedicated `stout` database.
 *
 * The walking-skeleton slice only needs to prove the runner executes; migration
 * 1 is intentionally a no-op. Migration 2 adds the semantic-search vector index
 * (`note_chunks`). Real schema lands in later slices as additional entries.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: "init",
    async up() {
      // No-op: the integration spine only needs to prove the runner executes.
    },
  },
  {
    version: 2,
    name: "note-search-index",
    async up(exec) {
      // Embedded note chunks for semantic search. One row per chunk, keyed by
      // note identity (`note_path`) so a re-index replaces a note wholesale. The
      // `vector(384)` width matches the embedding model (`Xenova/all-MiniLM-L6-v2`)
      // and its hashing fallback; pgvector is enabled in `bootstrapDatabase`.
      await exec(
        `CREATE TABLE IF NOT EXISTS note_chunks (
          id BIGSERIAL PRIMARY KEY,
          note_path TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          embedding vector(384) NOT NULL
        )`,
      );
      // Fast delete/lookup of a note's chunks during re-index.
      await exec(
        `CREATE INDEX IF NOT EXISTS note_chunks_note_path_idx
           ON note_chunks (note_path)`,
      );
      // Approximate nearest-neighbour index for cosine-distance ranking.
      await exec(
        `CREATE INDEX IF NOT EXISTS note_chunks_embedding_idx
           ON note_chunks USING ivfflat (embedding vector_cosine_ops)
           WITH (lists = 100)`,
      );
    },
  },
];
