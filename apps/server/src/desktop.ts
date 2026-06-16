/**
 * `desktop` — boot the same Stout HTTP API + UI over a **local** working clone.
 *
 * This is the server entry the Electron shell uses for the local-first desktop
 * app. It wires the very same {@link createApp} surface and the very same built
 * `@stout/ui` SPA that the web server serves — only the backing differs: a
 * {@link NodeGitEngine} over a local clone on disk, and an **in-memory** search
 * index (the pure hashing embedder + {@link InMemoryVectorStore}) instead of the
 * Postgres/pgvector stack. So the UI is byte-identical to the web app; there is no
 * UI fork.
 *
 * The public surface is deliberately **Express-free** ({@link LocalWorkspace} is
 * just a URL + a `close()`), so the emitted declarations the Electron app
 * typechecks against do not drag in `@types/express`. The host binds loopback
 * (`127.0.0.1`) on an ephemeral port by default — it is a local detail of the
 * desktop process, not a network service. Hub sync (clone/pull/push) is a separate
 * concern handled by {@link NodeHubRemoteEngine} before this is started.
 */

import type { Server } from "node:http";
import { join } from "node:path";
import {
  applyNoteSync,
  ASSETS_DIR,
  createHashingEmbedder,
  createNote,
  InMemoryVectorStore,
  moveNote,
  readLinkGraph,
  readNote,
  readNoteTree,
  renameNote,
  writeAttachment,
  writeNote,
  type HealthStatus,
} from "@stout/core";
import { createApp, resolveUiDir } from "./app.js";
import { NodeGitEngine } from "./git-engine.js";
import { createSearchService } from "./search.js";

// Re-export the repo/hub plumbing the Electron bootstrap needs, so the desktop
// shell imports everything Node-side from a single `@stout/server/desktop` entry.
export { NodeGitEngine, ensureWorkspaceRepo, loadRepoPaths } from "./git-engine.js";
export type { RepoPaths } from "./git-engine.js";
export { NodeHubRemoteEngine } from "./hub-engine.js";
export { resolveUiDir } from "./app.js";

/** How to start a {@link LocalWorkspace}. */
export interface LocalWorkspaceOptions {
  /** Absolute path to the local working clone the engine reads and edits. */
  cloneDir: string;
  /** Absolute path to the built UI assets; defaults to {@link resolveUiDir}. */
  uiDir?: string;
  /** Port to bind; defaults to `0` (an ephemeral port). */
  port?: number;
  /** Host/interface to bind; defaults to loopback (`127.0.0.1`). */
  host?: string;
}

/** A running local workspace host the Electron window loads. */
export interface LocalWorkspace {
  /** The loopback URL to load in the desktop window. */
  url: string;
  /** The port the host bound. */
  port: number;
  /** Stop the host and release the port. */
  close(): Promise<void>;
}

/**
 * Start the local-first workspace host over the working clone at `cloneDir` and
 * resolve once it is listening.
 *
 * Wires the full note API (tree, read/save, autosave-squash sync, create/rename/
 * move, links, attachments, search) exactly as the web server does, plus the
 * static UI. Health reports `ok` with `database: false` — the desktop app has no
 * Postgres, and that is the expected, healthy local-first state (so the UI's
 * System section shows the DB as absent rather than the app reporting degraded).
 * Search runs entirely in-memory and is rebuilt from the repo in the background on
 * start; index updates on edits are best-effort (logged, never failing an edit).
 */
export async function startLocalWorkspace(
  options: LocalWorkspaceOptions,
): Promise<LocalWorkspace> {
  const host = options.host ?? "127.0.0.1";
  const engine = new NodeGitEngine(options.cloneDir);
  const search = createSearchService({
    engine,
    store: new InMemoryVectorStore(),
    embedder: createHashingEmbedder(),
  });

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

  const getHealth = async (): Promise<HealthStatus> => ({
    status: "ok",
    service: "stout",
    database: false,
    migration: 0,
    timestamp: new Date().toISOString(),
  });

  const app = createApp({
    getHealth,
    getTree: () => readNoteTree(engine),
    getLinks: () => readLinkGraph(engine),
    getNote: (path) => readNote(engine, path),
    saveNote: async (path, markdown) => {
      const saved = await writeNote(engine, path, markdown);
      reindexNote(path);
      return saved;
    },
    syncNote: async (request) => {
      const response = await applyNoteSync(engine, request);
      if (request.action === "squash") reindexNote(request.path);
      return response;
    },
    createNote: async (parent, name) => {
      const created = await createNote(engine, parent, name);
      reindexNote(created.path);
      return created;
    },
    renameNote: async (path, name) => {
      const renamed = await renameNote(engine, path, name);
      rebuildSearch();
      return renamed;
    },
    moveNote: async (path, parent) => {
      const moved = await moveNote(engine, path, parent);
      rebuildSearch();
      return moved;
    },
    saveAttachment: (name, dataBase64) =>
      writeAttachment(engine, name, Buffer.from(dataBase64, "base64")),
    search: (request) => search.search(request),
    assetsDir: join(options.cloneDir, ASSETS_DIR),
    uiDir: options.uiDir ?? resolveUiDir(),
  });

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(options.port ?? 0, host, () => resolve(listening));
  });

  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : options.port ?? 0;

  // Build the in-memory index from the repo in the background so start is not
  // blocked; failures only log (the index is a derived projection of git).
  rebuildSearch();

  return {
    url: `http://${host}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
