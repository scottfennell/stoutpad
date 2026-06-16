/**
 * `core/search-index` — the pure, runtime-agnostic search core.
 *
 * Stout searches across every note two ways: a **semantic** search (notes are
 * chunked, each chunk embedded into a vector, and a query embedding ranked by
 * cosine similarity) and a **keyword/filename fallback** (term-frequency scoring
 * over titles, bodies, and paths) that always works without a model. Like the
 * rest of `@stout/core`, this module owns only the pure pieces: the chunker, the
 * ranking maths, the keyword scorer, the REST contract, and the {@link Embedder}
 * / {@link VectorStore} **seams** the heavy machinery hides behind. The actual
 * local embedding model and the pgvector store live in `apps/server`; an
 * in-memory store and a deterministic hashing embedder live here so the whole
 * pipeline is unit-tested offline.
 *
 * Git stays canonical: the vector index is a derived, disposable projection that
 * {@link rebuildIndex} can rebuild from the repo at any time.
 *
 * See `docs/adr/0008-semantic-search.md`.
 */

import {
  parseInline,
  parseMarkdown,
  type MarkdownBlock,
} from "./markdown.js";
import { normalizeNotePath } from "./note-content.js";
import type { NoteContent } from "./wikilink.js";

/** REST path of the search endpoint (`GET`, read-only). */
export const SEARCH_PATH = "/api/search" as const;

/** Default number of results returned by a search. */
export const DEFAULT_SEARCH_LIMIT = 10 as const;

/** Hard upper bound on a single search's result count (sanitizes client input). */
export const MAX_SEARCH_LIMIT = 50 as const;

/**
 * Target chunk size in characters. Notes are split into roughly chunk-sized
 * units of prose so each embedding covers a focused passage; chosen well under a
 * sentence-transformer's token window so a chunk never overflows the model.
 */
export const DEFAULT_CHUNK_SIZE = 512 as const;

/**
 * Default embedding dimensionality for the pure {@link createHashingEmbedder}.
 * The server overrides this to match its real model's output (and the pgvector
 * column width); this default only governs the dependency-free hashing embedder.
 */
export const DEFAULT_EMBEDDING_DIMENSIONS = 256 as const;

/** Which ranking produced a {@link SearchResponse}. */
export type SearchMode = "semantic" | "keyword";

/** Request parameters for a search (carried as `GET /api/search` query params). */
export interface SearchRequest {
  /** The user's raw query text. An empty/blank query yields no results. */
  query: string;
  /** Maximum results to return; defaults to {@link DEFAULT_SEARCH_LIMIT}. */
  limit?: number;
  /**
   * Force a ranking mode. `"keyword"` skips semantic search entirely; otherwise
   * semantic is attempted first and keyword is the automatic fallback.
   */
  mode?: SearchMode;
}

/** A single ranked search hit (one per note). */
export interface SearchResult {
  /** Identity (tree `path`) of the matching note; the root note is `""`. */
  path: string;
  /** The note's display title. */
  title: string;
  /** A short plain-text excerpt of the best-matching passage. */
  snippet: string;
  /** Relevance score (cosine similarity for semantic, term weight for keyword). */
  score: number;
}

/** Response body of `GET /api/search`. */
export interface SearchResponse {
  /** The normalized (trimmed) query that was run. */
  query: string;
  /** Which ranking actually produced {@link results}. */
  mode: SearchMode;
  /** Ranked results, best first (at most the requested limit). */
  results: SearchResult[];
}

/** One embeddable passage of a note. */
export interface NoteChunk {
  /** Identity (tree `path`) of the note this chunk belongs to. */
  notePath: string;
  /** The note's display title (frontmatter `title` overrides the derived one). */
  title: string;
  /** Position of this chunk within the note (0-based). */
  index: number;
  /** The chunk's plain-text content (Markdown formatting stripped). */
  text: string;
}

/** A {@link NoteChunk} paired with its embedding vector. */
export type EmbeddedChunk = NoteChunk & {
  /** The chunk's embedding (length equals the {@link Embedder}'s dimensions). */
  embedding: number[];
};

/** A {@link NoteChunk} scored against a query. */
export interface ScoredChunk {
  /** The chunk that matched. */
  chunk: NoteChunk;
  /** Its relevance score for the query (higher is better). */
  score: number;
}

/**
 * Turns text into a fixed-length embedding vector. Implemented by the server's
 * locally-run model in production and by {@link createHashingEmbedder} (pure,
 * deterministic) for the fallback and for tests.
 */
export interface Embedder {
  /** Stable identifier of the model/strategy (for diagnostics + index versioning). */
  id: string;
  /** Length of every vector this embedder produces. */
  dimensions: number;
  /** Embed `text` into a `dimensions`-length vector. */
  embed(text: string): Promise<number[]>;
}

/**
 * Persists embedded chunks and answers nearest-neighbour queries. Implemented by
 * the server's pgvector store in production and by {@link InMemoryVectorStore} in
 * tests. Keyed by note identity so re-indexing a note replaces its chunks wholesale.
 */
export interface VectorStore {
  /** Replace all stored chunks for `notePath` with `chunks` (empty clears it). */
  upsertNote(notePath: string, chunks: EmbeddedChunk[]): Promise<void>;
  /** Remove every chunk belonging to `notePath` (idempotent). */
  deleteNote(notePath: string): Promise<void>;
  /** Return the `limit` nearest stored chunks to `embedding`, best first. */
  queryNearest(embedding: number[], limit: number): Promise<ScoredChunk[]>;
  /** Drop every stored chunk (used before a full rebuild). */
  clear(): Promise<void>;
}

/** Lowercase the text and split it into alphanumeric tokens (Unicode-aware). */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Count occurrences of each token. */
function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/**
 * Flatten a run of inline Markdown to plain text: formatting delimiters are
 * dropped and a `[[wikilink]]` collapses to its display text (alias or target),
 * so neither the embedding nor the keyword scorer sees `**`, `` ` ``, or `[[…]]`.
 */
function inlineToText(raw: string): string {
  return parseInline(raw)
    .map((span) => (span.link ? span.link.alias ?? span.link.target : span.text))
    .join("");
}

/** Convert a note's parsed blocks into trimmed, non-empty plain-text segments. */
function blocksToText(blocks: MarkdownBlock[]): string[] {
  const segments: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
      case "paragraph":
        segments.push(inlineToText(block.text));
        break;
      case "bulletList":
        for (const item of block.items) segments.push(inlineToText(item));
        break;
      case "taskList":
        for (const item of block.items) segments.push(inlineToText(item.text));
        break;
    }
  }
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Word-wrap an over-long segment into pieces no longer than `chunkSize`. */
function splitLong(segment: string, chunkSize: number): string[] {
  if (segment.length <= chunkSize) return [segment];
  const pieces: string[] = [];
  let current = "";
  for (const word of segment.split(/\s+/u)) {
    if (current === "") current = word;
    else if (current.length + 1 + word.length <= chunkSize) current += ` ${word}`;
    else {
      pieces.push(current);
      current = word;
    }
  }
  if (current !== "") pieces.push(current);
  return pieces;
}

/** Greedily pack segments into chunks of at most `chunkSize` characters. */
function packSegments(segments: string[], chunkSize: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const segment of segments) {
    if (current === "") current = segment;
    else if (current.length + 1 + segment.length <= chunkSize) {
      current += `\n${segment}`;
    } else {
      chunks.push(current);
      current = segment;
    }
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

/**
 * Split a note into embeddable {@link NoteChunk}s.
 *
 * Pure: the note's Markdown is parsed (frontmatter stripped), each block reduced
 * to plain text (formatting + wikilink syntax removed), over-long passages word-
 * wrapped, and the result greedily packed into ~`chunkSize`-character chunks.
 * Every note yields at least one chunk (an empty body produces a single
 * title-only chunk) so it is always represented in the index.
 */
export function chunkNote(
  note: NoteContent,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): NoteChunk[] {
  const doc = parseMarkdown(note.markdown);
  const title = (doc.frontmatter?.title ?? note.title).trim();
  const segments = blocksToText(doc.blocks).flatMap((s) => splitLong(s, chunkSize));
  const texts = packSegments(segments, chunkSize);
  const bodies = texts.length > 0 ? texts : [""];
  return bodies.map((text, index) => ({ notePath: note.path, title, index, text }));
}

/** The text actually embedded for a chunk: its title prepended to its body. */
function chunkEmbedText(chunk: NoteChunk): string {
  return chunk.text ? `${chunk.title}\n\n${chunk.text}` : chunk.title;
}

const SNIPPET_LENGTH = 200;

/** Build a single-line, length-capped snippet from a passage. */
function makeSnippet(text: string): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (clean.length <= SNIPPET_LENGTH) return clean;
  return `${clean.slice(0, SNIPPET_LENGTH).trimEnd()}…`;
}

/**
 * Cosine similarity of two vectors in `[-1, 1]` (0 when either is the zero
 * vector). Tolerant of differing lengths — it compares the shared prefix — so a
 * dimension mismatch degrades rather than throwing.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Rank embedded chunks against a query embedding by {@link cosineSimilarity},
 * best first, keeping at most `limit`. Pure — the in-memory and pgvector stores
 * both lean on this for nearest-neighbour ordering.
 */
export function rankChunks(
  queryEmbedding: number[],
  chunks: EmbeddedChunk[],
  limit: number = DEFAULT_SEARCH_LIMIT,
): ScoredChunk[] {
  const scored = chunks.map((chunk): ScoredChunk => ({
    chunk: {
      notePath: chunk.notePath,
      title: chunk.title,
      index: chunk.index,
      text: chunk.text,
    },
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Collapse scored chunks into per-note {@link SearchResult}s: each note keeps its
 * single best-scoring chunk (for the snippet), and the notes are returned best
 * first, at most `limit`.
 */
export function chunksToResults(
  scored: ScoredChunk[],
  limit: number = DEFAULT_SEARCH_LIMIT,
): SearchResult[] {
  const best = new Map<string, SearchResult>();
  for (const { chunk, score } of scored) {
    const existing = best.get(chunk.notePath);
    if (existing && existing.score >= score) continue;
    best.set(chunk.notePath, {
      path: chunk.notePath,
      title: chunk.title,
      snippet: makeSnippet(chunk.text || chunk.title),
      score,
    });
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

/**
 * Keyword / filename fallback search.
 *
 * Pure term-frequency scoring over every note, so it works with no model and no
 * index: a query term scores in a note's **title** (weighted highest), its
 * **body**, and its **path/filename** (so `notes` matches `daily/notes.md`).
 * Notes matching no term are dropped; the rest are returned best first.
 */
export function keywordSearch(
  query: string,
  notes: NoteContent[],
  limit: number = DEFAULT_SEARCH_LIMIT,
): SearchResult[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];

  const results: SearchResult[] = [];
  for (const note of notes) {
    const doc = parseMarkdown(note.markdown);
    const title = (doc.frontmatter?.title ?? note.title).trim();
    const bodyText = blocksToText(doc.blocks).join("\n");
    const titleCounts = countTokens(tokenize(title));
    const bodyCounts = countTokens(tokenize(bodyText));
    const pathLower = note.path.toLowerCase();

    let score = 0;
    let matched = false;
    for (const term of terms) {
      const inTitle = titleCounts.get(term) ?? 0;
      const inBody = bodyCounts.get(term) ?? 0;
      if (inTitle > 0) {
        score += 3 * inTitle;
        matched = true;
      }
      if (inBody > 0) {
        score += inBody;
        matched = true;
      }
      if (pathLower.includes(term)) {
        score += 2;
        matched = true;
      }
    }
    if (!matched) continue;
    results.push({
      path: note.path,
      title,
      snippet: makeSnippet(bodyText || title),
      score,
    });
  }
  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return results.slice(0, limit);
}

/**
 * A pure, deterministic **hashing embedder** (the "feature hashing" trick): each
 * token is hashed to a bucket and a sign, accumulated, and the vector L2-
 * normalized. It needs no model download, so it backs the server's fallback when
 * the real model is unavailable and gives tests a stable embedder. Notes sharing
 * vocabulary land near each other, which is all the fallback ranking needs.
 */
export function createHashingEmbedder(
  dimensions: number = DEFAULT_EMBEDDING_DIMENSIONS,
): Embedder {
  return {
    id: `hashing-${dimensions}`,
    dimensions,
    async embed(text: string): Promise<number[]> {
      const vector = new Array<number>(dimensions).fill(0);
      for (const token of tokenize(text)) {
        const bucket = fnv1a(token) % dimensions;
        const sign = (fnv1a(`sign:${token}`) & 1) === 0 ? 1 : -1;
        vector[bucket] += sign;
      }
      return l2normalize(vector);
    },
  };
}

/** 32-bit FNV-1a hash of a string (unsigned). */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Scale a vector to unit length (a zero vector is returned unchanged). */
function l2normalize(vector: number[]): number[] {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

/**
 * In-memory {@link VectorStore} for tests and the pure pipeline, keyed by note
 * identity. Nearest-neighbour queries brute-force every stored chunk through
 * {@link rankChunks} — fine at test scale; the server's pgvector store does the
 * real ANN search.
 */
export class InMemoryVectorStore implements VectorStore {
  private readonly byNote = new Map<string, EmbeddedChunk[]>();

  async upsertNote(notePath: string, chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) this.byNote.delete(notePath);
    else this.byNote.set(notePath, chunks);
  }

  async deleteNote(notePath: string): Promise<void> {
    this.byNote.delete(notePath);
  }

  async queryNearest(embedding: number[], limit: number): Promise<ScoredChunk[]> {
    const all: EmbeddedChunk[] = [];
    for (const chunks of this.byNote.values()) all.push(...chunks);
    return rankChunks(embedding, all, limit);
  }

  async clear(): Promise<void> {
    this.byNote.clear();
  }
}

/** The store + embedder a note-indexing or semantic-search composition needs. */
export interface IndexDeps {
  /** Where embedded chunks are persisted and queried. */
  store: VectorStore;
  /** How chunk and query text are turned into vectors. */
  embedder: Embedder;
}

/**
 * Index a single note: chunk it, embed each chunk (title + body), and upsert the
 * note's chunks into the store (replacing any prior ones). The composition over
 * the {@link Embedder}/{@link VectorStore} seams; pure but for those calls.
 */
export async function indexNote(deps: IndexDeps, note: NoteContent): Promise<void> {
  const chunks = chunkNote(note);
  const embedded: EmbeddedChunk[] = [];
  for (const chunk of chunks) {
    const embedding = await deps.embedder.embed(chunkEmbedText(chunk));
    embedded.push({ ...chunk, embedding });
  }
  await deps.store.upsertNote(note.path, embedded);
}

/** Remove a note from the index by identity (used when a note is deleted/moved). */
export async function removeNoteFromIndex(
  deps: Pick<IndexDeps, "store">,
  notePath: string,
): Promise<void> {
  await deps.store.deleteNote(normalizeNotePath(notePath));
}

/**
 * Rebuild the whole index from a set of notes: clear the store, then index each
 * note. Because git is canonical and chunks are keyed by identity, this is the
 * "rebuild from scratch from the repo" path and is safe to run any time.
 */
export async function rebuildIndex(deps: IndexDeps, notes: NoteContent[]): Promise<void> {
  await deps.store.clear();
  for (const note of notes) await indexNote(deps, note);
}

/**
 * Run a semantic search: embed the query, fetch the nearest chunks (over-fetching
 * so per-note collapse still fills the limit), and reduce them to ranked per-note
 * results. The composition over the seams; the snippet comes from the stored
 * chunk text, so no note re-read is needed.
 */
export async function semanticSearch(
  deps: IndexDeps,
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
): Promise<SearchResult[]> {
  const queryEmbedding = await deps.embedder.embed(query);
  const scored = await deps.store.queryNearest(queryEmbedding, limit * 4);
  return chunksToResults(scored, limit);
}

/** Everything {@link runSearch} needs to answer a query both ways. */
export interface SearchDeps {
  /** Vector store for semantic search; omit (or omit `embedder`) to force keyword. */
  store?: VectorStore;
  /** Query embedder for semantic search; omit (or omit `store`) to force keyword. */
  embedder?: Embedder;
  /**
   * Load the note corpus for keyword search. Called lazily — only when keyword
   * search actually runs (an empty query or a successful semantic search skips
   * it) — so the (potentially expensive) read is avoided on the hot semantic path.
   */
  loadNotes: () => Promise<NoteContent[]>;
}

/** Clamp a requested limit to a sane positive integer ≤ {@link MAX_SEARCH_LIMIT}. */
function sanitizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return DEFAULT_SEARCH_LIMIT;
  return Math.min(n, MAX_SEARCH_LIMIT);
}

/**
 * Answer a {@link SearchRequest}, choosing the ranking and falling back as needed.
 *
 * - An empty/blank query short-circuits to no results.
 * - Semantic search runs when a store + embedder are present and the caller did
 *   not force `mode: "keyword"`; if it yields nothing (cold index) or throws (no
 *   model), the search **falls back to keyword** so a query always gets an answer.
 * - The response's `mode` reports which ranking actually produced the results.
 */
export async function runSearch(
  deps: SearchDeps,
  request: SearchRequest,
): Promise<SearchResponse> {
  const query = request.query.trim();
  const limit = sanitizeLimit(request.limit);
  if (query === "") return { query, mode: "keyword", results: [] };

  if (request.mode !== "keyword" && deps.store && deps.embedder) {
    try {
      const results = await semanticSearch(
        { store: deps.store, embedder: deps.embedder },
        query,
        limit,
      );
      if (results.length > 0) return { query, mode: "semantic", results };
    } catch {
      // Fall through to keyword search when the model/store is unavailable.
    }
  }

  const results = keywordSearch(query, await deps.loadNotes(), limit);
  return { query, mode: "keyword", results };
}
