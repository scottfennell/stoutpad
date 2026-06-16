/**
 * The server's search service: the composition that wires the `core/search-index`
 * pipeline to a concrete {@link GitEngine} (the note corpus), {@link VectorStore}
 * (pgvector), and {@link Embedder} (the local model or hashing fallback).
 *
 * It exposes the query path (`search`) the HTTP layer mounts at `GET /api/search`
 * and the index-maintenance paths the server triggers on commit: re-index a
 * single note after it is saved/squashed/created, and rebuild the whole index
 * (after a rename/move that changes note identities, and on boot). The vector
 * index is a derived projection of git — `rebuild` reconstructs it from the repo
 * at any time — so these hooks are best-effort: a failed index update never fails
 * the user's edit (the caller fires them and logs failures).
 */

import {
  indexNote,
  normalizeNotePath,
  readSearchableNotes,
  rebuildIndex,
  removeNoteFromIndex,
  runSearch,
  type Embedder,
  type GitEngine,
  type SearchRequest,
  type SearchResponse,
  type VectorStore,
} from "@stout/core";

/** The search + index-maintenance operations the server exposes. */
export interface SearchService {
  /** Answer a query (semantic with automatic keyword fallback). */
  search(request: SearchRequest): Promise<SearchResponse>;
  /** Re-index a single note by identity (removes it from the index if gone). */
  reindexNote(notePath: string): Promise<void>;
  /** Remove a note from the index by identity. */
  removeNote(notePath: string): Promise<void>;
  /** Rebuild the entire index from the repo (the canonical, from-scratch path). */
  rebuild(): Promise<void>;
}

export interface SearchServiceDeps {
  /** Reads the note corpus (and a single note's content) from the working clone. */
  engine: GitEngine;
  /** Persists embedded chunks and answers nearest-neighbour queries. */
  store: VectorStore;
  /** Turns chunk and query text into vectors (local model or hashing fallback). */
  embedder: Embedder;
}

export function createSearchService(deps: SearchServiceDeps): SearchService {
  const { engine, store, embedder } = deps;

  return {
    search(request: SearchRequest): Promise<SearchResponse> {
      // `loadNotes` is only invoked when keyword search actually runs, so the
      // corpus read is skipped on the hot semantic path.
      return runSearch(
        { store, embedder, loadNotes: () => readSearchableNotes(engine) },
        request,
      );
    },

    async reindexNote(notePath: string): Promise<void> {
      const target = normalizeNotePath(notePath);
      // Read the corpus (cheap file reads) so the note's title matches a full
      // rebuild exactly; only the matched note is embedded (the costly step).
      const notes = await readSearchableNotes(engine);
      const note = notes.find((n) => n.path === target);
      if (!note) {
        await removeNoteFromIndex({ store }, target);
        return;
      }
      await indexNote({ store, embedder }, note);
    },

    removeNote(notePath: string): Promise<void> {
      return removeNoteFromIndex({ store }, notePath);
    },

    async rebuild(): Promise<void> {
      const notes = await readSearchableNotes(engine);
      await rebuildIndex({ store, embedder }, notes);
    },
  };
}
