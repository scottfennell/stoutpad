import type pg from "pg";
import type { HealthStatus } from "@stout/core";
import { readNote, readNoteTree } from "@stout/core";
import { createApp, resolveUiDir } from "./app.js";
import {
  bootstrapDatabase,
  loadDbConfig,
  PgMigrationStore,
} from "./db.js";
import {
  ensureWorkspaceRepo,
  loadRepoPaths,
  NodeGitEngine,
} from "./git-engine.js";
import { runMigrations } from "./migrate.js";
import { migrations } from "./migrations.js";

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
    getNote: (path) => readNote(gitEngine, path),
    uiDir: resolveUiDir(),
  });
  app.listen(port, () => {
    console.log(`[stout] listening on http://0.0.0.0:${port}`);
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
