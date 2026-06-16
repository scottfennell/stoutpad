import type pg from "pg";
import type { HealthStatus } from "@stout/core";
import {
  applyNoteSync,
  ASSETS_DIR,
  createNote,
  moveNote,
  readLinkGraph,
  readNote,
  readNoteTree,
  renameNote,
  writeAttachment,
  writeNote,
} from "@stout/core";
import { createApp, resolveUiDir } from "./app.js";
import {
  bootstrapDatabase,
  loadDbConfig,
  PgMigrationStore,
} from "./db.js";
import { loadEmbedder } from "./embedder.js";
import {
  ensureWorkspaceRepo,
  loadRepoPaths,
  NodeGitEngine,
} from "./git-engine.js";
import { runMigrations } from "./migrate.js";
import { migrations } from "./migrations.js";
import { createSearchService } from "./search.js";
import { PgVectorStore } from "./search-store.js";
import { join } from "node:path";

async function main(): Promise<void> {
  const config = loadDbConfig();
  const port = Number(process.env.PORT ?? 3000);

  // Container → Postgres: create/use the dedicated `stout` db + enable pgvector.
  const pool = await bootstrapDatabase(config);

  // Run the migration runner on startup.
  const store = new PgMigrationStore(pool);
  const result = await runMigrations(store, migrations);
  console.log(
    `[stout] migrations at version ${result.currentVersion}` +
      (result.applied.length ? ` (applied ${result.applied.join(", ")})` : ""),
  );

  // First-boot: init the bare repo + working clone seeded with a starter note.
  const repoPaths = loadRepoPaths();
  await ensureWorkspaceRepo(repoPaths);
  const gitEngine = new NodeGitEngine(repoPaths.cloneDir);
  console.log(`[stout] note repository ready at ${repoPaths.cloneDir}`);

  // Semantic search: a locally-run embedding model (hashing fallback when it is
  // unavailable) + a pgvector store, composed with the engine into the service
  // the HTTP layer queries and the commit hooks keep up to date.
  const embedder = await loadEmbedder();
  const searchStore = new PgVectorStore(pool);
  const search = createSearchService({ engine: gitEngine, store: searchStore, embedder });

  // The vector index is a derived projection of git, so index updates are
  // best-effort: a failure never fails the user's edit, only logs.
  const reindexNote = (path: string): void => {
    void search
      .reindexNote(path)
      .catch((err) => console.error(`[stout] search re-index failed for "${path}"`, err));
  };
  const rebuildSearch = (): void => {
    void search
      .rebuild()
      .catch((err) => console.error("[stout] search rebuild failed", err));
  };

  const getHealth = async (): Promise<HealthStatus> => {
    const database = await checkDatabase(pool);
    return {
      status: database ? "ok" : "degraded",
      service: "stout",
      database,
      migration: result.currentVersion,
      timestamp: new Date().toISOString(),
    };
  };

  const app = createApp({
    getHealth,
    getTree: () => readNoteTree(gitEngine),
    getLinks: () => readLinkGraph(gitEngine),
    getNote: (path) => readNote(gitEngine, path),
    saveNote: async (path, markdown) => {
      const saved = await writeNote(gitEngine, path, markdown);
      reindexNote(path); // content now on `main`
      return saved;
    },
    syncNote: async (request) => {
      const response = await applyNoteSync(gitEngine, request);
      // Only a squash lands content on `main`; wip autosaves are not indexed.
      if (request.action === "squash") reindexNote(request.path);
      return response;
    },
    createNote: async (parent, name) => {
      const created = await createNote(gitEngine, parent, name);
      reindexNote(created.path);
      return created;
    },
    renameNote: async (path, name) => {
      const renamed = await renameNote(gitEngine, path, name);
      // A rename/move re-keys note identities (whole subtree for a parent), so
      // rebuild rather than chase every affected path.
      rebuildSearch();
      return renamed;
    },
    moveNote: async (path, parent) => {
      const moved = await moveNote(gitEngine, path, parent);
      rebuildSearch();
      return moved;
    },
    saveAttachment: (name, dataBase64) =>
      writeAttachment(gitEngine, name, Buffer.from(dataBase64, "base64")),
    search: (request) => search.search(request),
    assetsDir: join(repoPaths.cloneDir, ASSETS_DIR),
    uiDir: resolveUiDir(),
  });
  app.listen(port, () => {
    console.log(`[stout] listening on http://0.0.0.0:${port}`);
    // Build the index from the repo in the background so startup is not blocked;
    // this also reconciles the index with the current embedder on every boot.
    console.log("[stout] building search index in the background");
    rebuildSearch();
  });
}

async function checkDatabase(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error("[stout] fatal startup error", err);
  process.exit(1);
});
