import type { Migration } from "./migrate.js";

/**
 * Ordered list of schema migrations for the dedicated `stout` database.
 *
 * The walking-skeleton slice only needs to prove the runner executes; migration
 * 1 is intentionally a no-op. Real schema (notes metadata, vector index) lands
 * in later slices as additional entries.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: "init",
    async up() {
      // No-op: the integration spine only needs to prove the runner executes.
    },
  },
];
