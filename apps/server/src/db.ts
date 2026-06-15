import pg from "pg";
import type { Migration, MigrationStore } from "./migrate.js";

const { Pool, Client } = pg;

export interface DbConfig {
  /** Connection string to the Postgres instance (maintenance database). */
  databaseUrl: string;
  /** Name of the dedicated application database to create/use. */
  appDatabase: string;
}

export function loadDbConfig(env = process.env): DbConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return {
    databaseUrl,
    appDatabase: env.STOUT_DB_NAME ?? "stout",
  };
}

/** Build a connection string pointing at a specific database on the same host. */
function withDatabase(databaseUrl: string, database: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Ensure the dedicated `stout` database exists and has the `vector` extension
 * enabled. Connects to the maintenance database to create the app database if
 * missing, then enables pgvector on the app database. Returns a Pool bound to
 * the app database.
 */
export async function bootstrapDatabase(config: DbConfig): Promise<pg.Pool> {
  const admin = new Client({ connectionString: config.databaseUrl });
  await admin.connect();
  try {
    const { rowCount } = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [config.appDatabase],
    );
    if (rowCount === 0) {
      // Database names cannot be parameterized; identifier is validated below.
      await admin.query(`CREATE DATABASE ${quoteIdent(config.appDatabase)}`);
    }
  } finally {
    await admin.end();
  }

  const pool = new Pool({
    connectionString: withDatabase(config.databaseUrl, config.appDatabase),
  });
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  return pool;
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe database identifier: ${name}`);
  }
  return `"${name}"`;
}

const LEDGER_TABLE = "_stout_migrations";

/** Postgres-backed {@link MigrationStore} using a ledger table. */
export class PgMigrationStore implements MigrationStore {
  constructor(private readonly pool: pg.Pool) {}

  async init(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    );
  }

  async appliedVersions(): Promise<number[]> {
    const { rows } = await this.pool.query<{ version: number }>(
      `SELECT version FROM ${LEDGER_TABLE} ORDER BY version`,
    );
    return rows.map((r) => r.version);
  }

  async apply(migration: Migration): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await migration.up((sql, params) =>
        client.query(sql, params).then(() => undefined),
      );
      await client.query(
        `INSERT INTO ${LEDGER_TABLE} (version, name) VALUES ($1, $2)`,
        [migration.version, migration.name],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
