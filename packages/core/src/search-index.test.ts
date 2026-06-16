import { describe, expect, it } from "vitest";
import {
  chunkNote,
  chunksToResults,
  cosineSimilarity,
  createHashingEmbedder,
  indexNote,
  InMemoryVectorStore,
  keywordSearch,
  rankChunks,
  rebuildIndex,
  removeNoteFromIndex,
  runSearch,
  semanticSearch,
  DEFAULT_CHUNK_SIZE,
  MAX_SEARCH_LIMIT,
  type EmbeddedChunk,
  type Embedder,
  type NoteContent,
  type SearchDeps,
} from "./index.js";

/** A few notes with deliberately disjoint vocabulary for ranking assertions. */
const NOTES: NoteContent[] = [
  {
    path: "fruit",
    title: "Fruit",
    markdown: "# Fruit\n\nApple banana cherry are sweet orchard fruit.\n",
  },
  {
    path: "infra",
    title: "Infrastructure",
    markdown: "# Infrastructure\n\nDatabase server network cluster latency.\n",
  },
  {
    path: "travel",
    title: "Travel",
    markdown: "# Travel\n\nMountain river forest trail backpack journey.\n",
  },
];

/**
 * A controllable stub {@link Embedder}: maps each note/query to a fixed unit
 * vector so semantic ranking is deterministic and independent of the hashing
 * heuristic. Unknown text embeds to the zero vector.
 */
function stubEmbedder(vectors: Record<string, number[]>, dimensions = 3): Embedder {
  return {
    id: "stub",
    dimensions,
    async embed(text: string): Promise<number[]> {
      for (const [needle, vector] of Object.entries(vectors)) {
        if (text.toLowerCase().includes(needle)) return vector;
      }
      return new Array<number>(dimensions).fill(0);
    },
  };
}

describe("chunkNote", () => {
  it("produces a single title-only chunk for an empty body", () => {
    const chunks = chunkNote({ path: "p", title: "Empty", markdown: "" });
    expect(chunks).toEqual([{ notePath: "p", title: "Empty", index: 0, text: "" }]);
  });

  it("lets a frontmatter title override the derived title", () => {
    const chunks = chunkNote({
      path: "p",
      title: "Derived",
      markdown: "---\ntitle: Real Title\n---\n\nbody text\n",
    });
    expect(chunks[0].title).toBe("Real Title");
    expect(chunks[0].text).toBe("body text");
  });

  it("strips markdown formatting and wikilink syntax from chunk text", () => {
    const chunks = chunkNote({
      path: "p",
      title: "P",
      markdown: "Plain **bold** and `code` and [[Target Note|shown alias]].\n",
    });
    expect(chunks[0].text).toBe("Plain bold and code and shown alias.");
  });

  it("splits a long note into multiple chunks under the size budget", () => {
    const para = "word ".repeat(400).trim(); // ~2000 chars, one paragraph
    const chunks = chunkNote({ path: "p", title: "Long", markdown: `${para}\n` });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(DEFAULT_CHUNK_SIZE);
    }
    // Chunks are indexed in order.
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it("captures list and task-list items as text", () => {
    const chunks = chunkNote({
      path: "p",
      title: "Lists",
      markdown: "- alpha\n- beta\n\n- [ ] todo\n- [x] done\n",
    });
    const text = chunks.map((c) => c.text).join(" ");
    expect(text).toContain("alpha");
    expect(text).toContain("todo");
    expect(text).toContain("done");
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical directions and 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("is 0 when either vector is the zero vector", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
  });

  it("compares the shared prefix when lengths differ", () => {
    expect(cosineSimilarity([1, 0, 99], [1, 0])).toBeCloseTo(1);
  });
});

describe("createHashingEmbedder", () => {
  it("is deterministic, correctly sized, and L2-normalized", async () => {
    const embedder = createHashingEmbedder(64);
    expect(embedder.dimensions).toBe(64);
    const a = await embedder.embed("apple banana");
    const b = await embedder.embed("apple banana");
    expect(a).toEqual(b);
    expect(a).toHaveLength(64);
    const norm = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1);
  });

  it("embeds shared vocabulary nearer than disjoint vocabulary", async () => {
    const embedder = createHashingEmbedder(256);
    const query = await embedder.embed("apple banana cherry");
    const near = await embedder.embed("apple banana cherry orchard");
    const far = await embedder.embed("database server network");
    expect(cosineSimilarity(query, near)).toBeGreaterThan(
      cosineSimilarity(query, far),
    );
  });
});

describe("rankChunks", () => {
  it("orders chunks by cosine similarity, best first, honoring the limit", () => {
    const chunks: EmbeddedChunk[] = [
      { notePath: "a", title: "A", index: 0, text: "a", embedding: [1, 0] },
      { notePath: "b", title: "B", index: 0, text: "b", embedding: [0, 1] },
      { notePath: "c", title: "C", index: 0, text: "c", embedding: [0.9, 0.1] },
    ];
    const ranked = rankChunks([1, 0], chunks, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked.map((r) => r.chunk.notePath)).toEqual(["a", "c"]);
  });
});

describe("chunksToResults", () => {
  it("keeps each note's single best chunk and sorts notes best first", () => {
    const results = chunksToResults([
      { chunk: { notePath: "a", title: "A", index: 0, text: "low" }, score: 0.2 },
      { chunk: { notePath: "a", title: "A", index: 1, text: "high" }, score: 0.9 },
      { chunk: { notePath: "b", title: "B", index: 0, text: "mid" }, score: 0.5 },
    ]);
    expect(results).toEqual([
      { path: "a", title: "A", snippet: "high", score: 0.9 },
      { path: "b", title: "B", snippet: "mid", score: 0.5 },
    ]);
  });
});

describe("keywordSearch", () => {
  it("weights title matches above body and matches the path/filename", () => {
    const results = keywordSearch("fruit", NOTES);
    expect(results[0].path).toBe("fruit");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("matches a note by its path even when the body does not contain the term", () => {
    const notes: NoteContent[] = [
      { path: "daily/standup", title: "Standup", markdown: "# Standup\n\nnotes\n" },
    ];
    expect(keywordSearch("standup", notes).map((r) => r.path)).toEqual([
      "daily/standup",
    ]);
  });

  it("drops notes matching no term and returns nothing for a blank query", () => {
    expect(keywordSearch("zzzznotacorpusword", NOTES)).toEqual([]);
    expect(keywordSearch("   ", NOTES)).toEqual([]);
  });
});

describe("InMemoryVectorStore", () => {
  it("upserts, deletes, queries, and clears chunks keyed by note", async () => {
    const store = new InMemoryVectorStore();
    await store.upsertNote("a", [
      { notePath: "a", title: "A", index: 0, text: "a", embedding: [1, 0] },
    ]);
    await store.upsertNote("b", [
      { notePath: "b", title: "B", index: 0, text: "b", embedding: [0, 1] },
    ]);

    expect((await store.queryNearest([1, 0], 5)).map((s) => s.chunk.notePath)).toEqual(
      ["a", "b"],
    );

    await store.deleteNote("a");
    expect((await store.queryNearest([1, 0], 5)).map((s) => s.chunk.notePath)).toEqual(
      ["b"],
    );

    // An empty upsert clears a note's chunks.
    await store.upsertNote("b", []);
    expect(await store.queryNearest([1, 0], 5)).toEqual([]);
  });
});

describe("indexNote / rebuildIndex / removeNoteFromIndex", () => {
  it("indexes a note's chunks into the store", async () => {
    const store = new InMemoryVectorStore();
    const embedder = createHashingEmbedder(64);
    await indexNote({ store, embedder }, NOTES[0]);
    const hits = await store.queryNearest(await embedder.embed("apple"), 10);
    expect(hits.every((h) => h.chunk.notePath === "fruit")).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("rebuilds the whole index from scratch", async () => {
    const store = new InMemoryVectorStore();
    const embedder = createHashingEmbedder(64);
    // Seed stale state, then rebuild over it.
    await indexNote({ store, embedder }, {
      path: "stale",
      title: "Stale",
      markdown: "obsolete\n",
    });
    await rebuildIndex({ store, embedder }, NOTES);

    const all = await store.queryNearest(await embedder.embed("anything"), 100);
    const paths = new Set(all.map((h) => h.chunk.notePath));
    expect(paths.has("stale")).toBe(false);
    expect(paths).toEqual(new Set(["fruit", "infra", "travel"]));
  });

  it("removes a note from the index by identity", async () => {
    const store = new InMemoryVectorStore();
    const embedder = createHashingEmbedder(64);
    await rebuildIndex({ store, embedder }, NOTES);
    await removeNoteFromIndex({ store }, "fruit");
    const all = await store.queryNearest(await embedder.embed("anything"), 100);
    expect(all.some((h) => h.chunk.notePath === "fruit")).toBe(false);
  });
});

describe("semanticSearch", () => {
  it("ranks the note whose embedding is nearest the query first", async () => {
    const embedder = stubEmbedder({
      fruit: [1, 0, 0],
      apple: [1, 0, 0],
      infra: [0, 1, 0],
      travel: [0, 0, 1],
    });
    const store = new InMemoryVectorStore();
    await rebuildIndex({ store, embedder }, NOTES);

    const results = await semanticSearch({ store, embedder }, "apple", 3);
    expect(results[0].path).toBe("fruit");
  });
});

describe("runSearch", () => {
  const loadNotes = async (): Promise<NoteContent[]> => NOTES;

  it("short-circuits a blank query to no results (keyword mode)", async () => {
    const deps: SearchDeps = { loadNotes };
    const response = await runSearch(deps, { query: "   " });
    expect(response).toEqual({ query: "", mode: "keyword", results: [] });
  });

  it("runs semantic search when a store and embedder are present", async () => {
    const embedder = stubEmbedder({
      fruit: [1, 0, 0],
      apple: [1, 0, 0],
      infra: [0, 1, 0],
      travel: [0, 0, 1],
    });
    const store = new InMemoryVectorStore();
    await rebuildIndex({ store, embedder }, NOTES);

    const response = await runSearch({ store, embedder, loadNotes }, { query: "apple" });
    expect(response.mode).toBe("semantic");
    expect(response.results[0].path).toBe("fruit");
  });

  it("uses keyword search when mode is forced to keyword", async () => {
    const embedder = stubEmbedder({ apple: [1, 0, 0] });
    const store = new InMemoryVectorStore();
    await rebuildIndex({ store, embedder }, NOTES);

    const response = await runSearch(
      { store, embedder, loadNotes },
      { query: "fruit", mode: "keyword" },
    );
    expect(response.mode).toBe("keyword");
    expect(response.results[0].path).toBe("fruit");
  });

  it("falls back to keyword when semantic search yields nothing (cold index)", async () => {
    const embedder = stubEmbedder({ apple: [1, 0, 0] });
    const store = new InMemoryVectorStore(); // empty: no chunks to match

    const response = await runSearch({ store, embedder, loadNotes }, { query: "fruit" });
    expect(response.mode).toBe("keyword");
    expect(response.results[0].path).toBe("fruit");
  });

  it("falls back to keyword when the embedder throws (no model available)", async () => {
    const embedder: Embedder = {
      id: "broken",
      dimensions: 3,
      async embed(): Promise<number[]> {
        throw new Error("model unavailable");
      },
    };
    const store = new InMemoryVectorStore();

    const response = await runSearch({ store, embedder, loadNotes }, { query: "fruit" });
    expect(response.mode).toBe("keyword");
    expect(response.results[0].path).toBe("fruit");
  });

  it("clamps the limit to a sane positive integer", async () => {
    const response = await runSearch({ loadNotes }, { query: "fruit", limit: 9999 });
    expect(response.results.length).toBeLessThanOrEqual(MAX_SEARCH_LIMIT);
  });
});
