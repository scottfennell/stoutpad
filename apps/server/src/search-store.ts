/**
 * Postgres + pgvector implementation of the `core/search-index` {@link VectorStore}.
 *
 * This is the Node/DB side of the search seam: embedded note chunks live in the
 * `note_chunks` table (created by migration 2), keyed by note identity so a
 * re-index replaces a note's chunks wholesale. Nearest-neighbour queries use
 * pgvector's cosine distance operator (`<=>`) with the ivfflat index, so ranking
 * is done in the database rather than by brute force. The pure ranking maths and
 * the in-memory store stay in `@stout/core`; only this adapter touches `pg`.
 */

import type pg from "pg";
import type { EmbeddedChunk, ScoredChunk, VectorStore } from "@stout/core";

/** Serialize a vector into pgvector's text literal form, e.g. `[0.1,0.2,0.3]`. */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/** Row shape returned by the nearest-neighbour query. */
interface ChunkRow {
  note_path: string;
  chunk_index: number;
  title: string;
  content: string;
  score: number;
}

/** A {@link VectorStore} backed by the `note_chunks` pgvector table. */
export class PgVectorStore implements VectorStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Replace every stored chunk for `notePath` with `chunks` in one transaction
   * (delete-then-insert), so a re-index is atomic and never leaves a note half
   * indexed. An empty `chunks` simply clears the note.
   */
  async upsertNote(notePath: string, chunks: EmbeddedChunk[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM note_chunks WHERE note_path = $1", [notePath]);
      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO note_chunks (note_path, chunk_index, title, content, embedding)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            chunk.notePath,
            chunk.index,
            chunk.title,
            chunk.text,
            toVectorLiteral(chunk.embedding),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** Remove every chunk belonging to `notePath` (idempotent). */
  async deleteNote(notePath: string): Promise<void> {
    await this.pool.query("DELETE FROM note_chunks WHERE note_path = $1", [notePath]);
  }

  /**
   * Return the `limit` nearest stored chunks to `embedding` by cosine distance,
   * best first. `score` is `1 - distance`, i.e. cosine similarity in `[-1, 1]`,
   * matching the in-memory store's ranking.
   */
  async queryNearest(embedding: number[], limit: number): Promise<ScoredChunk[]> {
    const literal = toVectorLiteral(embedding);
    const { rows } = await this.pool.query<ChunkRow>(
      `SELECT note_path, chunk_index, title, content,
              1 - (embedding <=> $1) AS score
         FROM note_chunks
        ORDER BY embedding <=> $1
        LIMIT $2`,
      [literal, limit],
    );
    return rows.map((row) => ({
      chunk: {
        notePath: row.note_path,
        title: row.title,
        index: row.chunk_index,
        text: row.content,
      },
      score: Number(row.score),
    }));
  }

  /** Drop every stored chunk (used before a full rebuild). */
  async clear(): Promise<void> {
    await this.pool.query("DELETE FROM note_chunks");
  }
}
