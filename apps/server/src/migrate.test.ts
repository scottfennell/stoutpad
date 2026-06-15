import { describe, expect, it } from "vitest";
import {
  runMigrations,
  type Migration,
  type MigrationStore,
} from "./migrate.js";

/** In-memory store so the runner's behaviour is tested without Postgres. */
class InMemoryStore implements MigrationStore {
  initialized = false;
  readonly records: { version: number; name: string }[] = [];

  async init(): Promise<void> {
    this.initialized = true;
  }
  async appliedVersions(): Promise<number[]> {
    return this.records.map((r) => r.version);
  }
  async apply(migration: Migration): Promise<void> {
    await migration.up(async () => {});
    this.records.push({ version: migration.version, name: migration.name });
  }
}

function migration(version: number, onUp?: () => void): Migration {
  return {
    version,
    name: `m${version}`,
    async up() {
      onUp?.();
    },
  };
}

describe("runMigrations", () => {
  it("applies all pending migrations in ascending order", async () => {
    const store = new InMemoryStore();
    const order: number[] = [];
    const result = await runMigrations(store, [
      migration(2, () => order.push(2)),
      migration(1, () => order.push(1)),
    ]);

    expect(store.initialized).toBe(true);
    expect(order).toEqual([1, 2]);
    expect(result.applied).toEqual([1, 2]);
    expect(result.currentVersion).toBe(2);
  });

  it("is idempotent: a second run applies nothing", async () => {
    const store = new InMemoryStore();
    const defs = [migration(1), migration(2)];

    await runMigrations(store, defs);
    const second = await runMigrations(store, defs);

    expect(second.applied).toEqual([]);
    expect(second.currentVersion).toBe(2);
    expect(store.records).toHaveLength(2);
  });

  it("only applies newly added migrations", async () => {
    const store = new InMemoryStore();
    await runMigrations(store, [migration(1)]);

    const result = await runMigrations(store, [migration(1), migration(2)]);
    expect(result.applied).toEqual([2]);
    expect(result.currentVersion).toBe(2);
  });

  it("rejects duplicate versions", async () => {
    const store = new InMemoryStore();
    await expect(
      runMigrations(store, [migration(1), migration(1)]),
    ).rejects.toThrow(/Duplicate migration version/);
  });

  it("reports version 0 when there are no migrations", async () => {
    const store = new InMemoryStore();
    const result = await runMigrations(store, []);
    expect(result.currentVersion).toBe(0);
  });
});
