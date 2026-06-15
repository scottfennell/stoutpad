/**
 * Migration runner.
 *
 * The runner is decoupled from Postgres via the {@link MigrationStore} seam so
 * its ordering / idempotency behaviour can be tested against an in-memory store,
 * while production uses the pg-backed store in `pg-store.ts`.
 */

export interface Migration {
  /** Monotonic, unique version. Migrations apply in ascending order. */
  version: number;
  /** Human-readable name (used for the migrations ledger). */
  name: string;
  /** Apply the migration. A no-op body is valid (e.g. the skeleton slice). */
  up(exec: (sql: string, params?: unknown[]) => Promise<void>): Promise<void>;
}

export interface MigrationStore {
  /** Ensure the ledger table (or equivalent) exists. */
  init(): Promise<void>;
  /** Versions already applied. */
  appliedVersions(): Promise<number[]>;
  /**
   * Apply a single migration and record it atomically. Implementations should
   * run the migration body and the ledger insert in one transaction.
   */
  apply(migration: Migration): Promise<void>;
}

export interface MigrationResult {
  /** Versions applied during this run (in order). */
  applied: number[];
  /** Highest applied version across all runs, or 0 if none. */
  currentVersion: number;
}

/**
 * Apply any migrations not yet recorded in the store, in ascending version
 * order. Safe to call repeatedly; already-applied migrations are skipped.
 */
export async function runMigrations(
  store: MigrationStore,
  migrations: Migration[],
): Promise<MigrationResult> {
  await store.init();

  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  assertUniqueVersions(ordered);

  const done = new Set(await store.appliedVersions());
  const applied: number[] = [];

  for (const migration of ordered) {
    if (done.has(migration.version)) continue;
    await store.apply(migration);
    applied.push(migration.version);
  }

  const allVersions = new Set([...done, ...applied]);
  const currentVersion = allVersions.size === 0 ? 0 : Math.max(...allVersions);

  return { applied, currentVersion };
}

function assertUniqueVersions(migrations: Migration[]): void {
  const seen = new Set<number>();
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new Error(`Duplicate migration version: ${m.version}`);
    }
    seen.add(m.version);
  }
}
