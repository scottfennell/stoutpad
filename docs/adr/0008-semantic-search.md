# 8. Semantic + keyword search

- Status: Accepted
- Date: 2026-06-16
- Issue: #10 (Semantic + keyword search)

## Context

Notes are now writable, linkable, and richly formatted, but there is no way to
**find** anything across them beyond walking the tree. We want search that
understands meaning ("notes about deployment") rather than only literal
substrings, while still returning useful results when meaning-based ranking is
unavailable.

Several forces shape the design:

- **Git stays canonical (ADR 0001).** A search index is a *derived projection*
  of the repo, never a second source of truth. It must be **fully rebuildable
  from the repo at any time**, and an index update must never be able to corrupt
  or block a write.
- **`@stout/core` stays pure (ADR 0001–0007).** Chunking and ranking are
  algorithmic and belong in core, behind seams, unit-tested offline with a
  **deterministic stub embedder** — no model download, no Postgres, no network.
- **Local-first, no third-party API.** Embeddings are produced by a model that
  runs **on the server, in-process** — not a hosted embedding API — so notes
  never leave the box.
- **Resilience over fidelity.** The embedding model is a heavy, optional native
  dependency. A missing/broken model must **degrade** search (to keyword/filename
  ranking) rather than crash the server.
- **Tested at the seam (ADR 0004–0007).** HTTP behaviour, the pgvector adapter,
  and the UI are tested against injected fakes, exactly as the prior slices are.

## Decision

### `core/search-index` owns chunking, ranking, and the contracts

A new pure module holds everything runtime-agnostic:

- **Chunking.** `chunkNote` reuses `core/markdown` (`parseMarkdown` + an inline
  flattener) to turn a note's body into plain text, then splits it into
  bounded-size `NoteChunk`s carrying the note `path`, the **effective title**
  (frontmatter `title` override re-applied, ADR 0007), and a chunk index. The
  title is prepended to the first chunk so a note's name is itself searchable.
- **The index seam.** Two narrow interfaces keep IO out of core: an `Embedder`
  (`{ id, dimensions, embed(text) }`) turns text into a vector, and a
  `VectorStore` (`upsertNote` / `deleteNote` / `queryNearest` / `clear`) persists
  embedded chunks and answers nearest-neighbour queries. `indexNote`,
  `removeNoteFromIndex`, and `rebuildIndex` compose an `Embedder` + `VectorStore`;
  `semanticSearch` embeds the query and ranks via `queryNearest`, de-duplicating
  to the best-scoring chunk per note.
- **Two ranking paths + automatic fallback.** `keywordSearch` is a pure
  title/path/body term scorer (title and filename weighted highest) over the note
  corpus — the **keyword/filename fallback**. `runSearch` is the policy: it runs
  semantic search when an embedder + store are available, and falls back to
  keyword search when the caller asks for it, when the index is unavailable, when
  semantic search throws, or when it yields nothing. The `SearchResponse` reports
  **which mode actually ran**, so degradation is visible, not silent.
- **A reference `VectorStore`.** `InMemoryVectorStore` (cosine similarity over an
  in-memory map) and `createHashingEmbedder` (a deterministic, dependency-free
  hashing embedder) let the whole pipeline — and the production fallback — be
  exercised without a model or a database.
- **The HTTP contract.** `SEARCH_PATH` + `SearchRequest { query, limit?, mode? }`
  / `SearchResponse { query, mode, results }` live in core alongside the other
  API contracts.

`core/git-engine` gains `readSearchableNotes` (the note corpus as
`{ path, title, markdown }`, title override applied), refactored out of the
existing link-graph read so search and links share one corpus reader.

### The server runs a local model into pgvector, indexed on commit

- **Model.** `apps/server/embedder.ts` loads `Xenova/all-MiniLM-L6-v2`
  (384-dim sentence-transformer) via `@xenova/transformers`, which runs ONNX
  inference **in-process**. The package is an **optional** dependency, imported
  through a computed specifier so it is neither type-checked nor bundled; if it
  (or its native runtime) cannot load, `loadEmbedder` returns the core
  `createHashingEmbedder` at the same 384 dimensions. Everything downstream sees
  only the `Embedder` seam, so the fallback is transparent.
- **Store.** `apps/server/search-store.ts` (`PgVectorStore`) implements
  `VectorStore` over a `note_chunks` table (migration **v2**): `vector(384)`
  column, a btree index on `note_path`, and an **ivfflat** index on the embedding
  (`vector_cosine_ops`) so nearest-neighbour ranking happens **in the database**
  via pgvector's `<=>` cosine operator. A re-index is an atomic delete-then-insert
  per note, so a note is never left half-indexed.
- **Index maintenance.** `apps/server/search.ts` (`createSearchService`) composes
  the engine + store + embedder into `search` / `reindexNote` / `removeNote` /
  `rebuild`. The server wires index updates to commits: a single note is
  re-indexed after it is **saved**, **squashed** to `main`, or **created**;
  a **rename/move** (which re-keys identities across a subtree) and **every boot**
  trigger a full `rebuild()` from the repo. Because the index is derived, these
  hooks are **fire-and-forget**: a failed index update is logged, never failing
  the user's edit, and `rebuild()` reconciles the index — including a change of
  embedder — from git at any time.
- **Endpoint.** `GET /api/search?q=&limit=&mode=` is mounted (only when a searcher
  is injected) and answers with the ranked `SearchResponse`. Read-only; an empty
  query yields an empty result set.

### The UI presents a search view that opens a chosen note

`packages/ui` adds `search-client.ts` (`getSearch`) and a `SearchPanel` (with a
`useSearch` hook) in the center column: a debounced search box that queries the
index only on **non-empty** input, lists ranked hits (title + snippet) labelled
with the mode that ran, and — on click — selects that note, reusing the exact
same `setSelected` navigation as the tree and wikilinks (ADR 0006).

## Consequences

- **Chunking + ranking are unit-tested purely, offline.** The chunker, cosine
  ranking, keyword scorer, `runSearch` fallback policy, and the index operations
  are tested behind the `Embedder`/`VectorStore` interfaces with a deterministic
  stub/hashing embedder and the in-memory store — no model, Postgres, or network
  (criterion: *chunking + ranking unit-tested behind the index interface with a
  deterministic stub embedder*).
- **Git stays canonical and the index is disposable.** `rebuild()` reconstructs
  the entire index from the repo, so the index can be dropped, corrupted, or
  rebuilt with a different model and simply regenerated; commit hooks keep it
  warm but are never authoritative (criterion: *updates on commit and rebuildable
  from scratch*).
- **Search degrades instead of failing.** With no model (e.g. the native ONNX
  runtime is unavailable in the install/runtime environment), `loadEmbedder`
  falls back to the hashing embedder and `runSearch` falls back to
  keyword/filename ranking; the response's `mode` shows which path served the
  query (criterion: *keyword/filename fallback works*). The trade-off is that
  hashing-embedder "semantic" results are not semantically meaningful — they are
  a structural placeholder, and real semantic quality requires the model to load.
- **Embeddings stay local.** Inference runs in-process via ONNX; notes are never
  sent to a third-party embedding API (criterion: *embedded via a locally-run
  model on the server*).
- **The model is heavy and its native build may be skipped at install.** The
  pnpm build-script allowlist does not enable the model's native deps, so in some
  environments the model will not load and search runs on the fallback until the
  native runtime is provisioned. This is an accepted resilience trade-off, not a
  failure mode: the dependency is optional by design.
- **Indexing is best-effort and eventually consistent.** A note is searchable a
  moment after its commit (the async hook completes), and wip autosaves are *not*
  indexed — only content on `main` is — so the index reflects committed,
  squashed state, matching where git is canonical.
