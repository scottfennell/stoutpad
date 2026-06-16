/**
 * The in-browser data source: a `fetch`-shaped adapter over the offline engine.
 *
 * This is the seam that lets the **one** `App` run with **two** backends and no
 * UI fork. The server-backed web app and the Electron desktop hand `App` the
 * real global `fetch`, so every hook and `*-client.ts` talks to the live
 * `/api/*` HTTP surface. The **PWA offline runtime** instead hands `App` the
 * function returned by {@link createBrowserApiFetch}: a `typeof fetch` that
 * answers the very same `/api/*` requests **locally**, by running the same
 * `@stout/core` compositions (`readNoteTree` / `readNote` / `writeNote` /
 * `applyNoteSync` / `readLinkGraph` / `keywordSearch`) against the IndexedDB
 * {@link BrowserGitEngine} — never touching the network.
 *
 * So the request/response contracts in `@stout/core` are the single source of
 * truth: the offline adapter reuses the exact same path constants, request
 * bodies, and response shapes the server route handlers do, just dispatched in
 * the browser. Reads (tree, note, links, search, health) and the autosave/squash
 * sync loop are fully supported offline; note **mutations** (create/rename/move)
 * and **attachments** are answered with a graceful `501` until the browser
 * engine grows those seams (the UI surfaces the message inline). See ADR 0011.
 */

import {
  DEFAULT_SEARCH_LIMIT,
  HEALTH_PATH,
  LINKS_PATH,
  MAX_SEARCH_LIMIT,
  NOTE_CREATE_PATH,
  NOTE_MOVE_PATH,
  NOTE_PATH,
  NOTE_RENAME_PATH,
  SEARCH_PATH,
  SYNC_PATH,
  TREE_PATH,
  ATTACHMENT_PATH,
  applyNoteSync,
  keywordSearch,
  readLinkGraph,
  readNote,
  readNoteTree,
  readSearchableNotes,
  wipBranchName,
  writeNote,
  type GitEngine,
  type HealthStatus,
  type NoteSaveRequest,
  type SearchResponse,
  type WipSyncEngine,
  type WritableGitEngine,
} from "@stout/core";

/** A JSON `Response` with the given status (defaults to 200). */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Resolve a `fetch` input (string / URL / Request) to a parsed {@link URL}. */
function toUrl(input: RequestInfo | URL): URL {
  const raw =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  // The app only issues relative `/api/...` URLs; a fixed base makes them absolute.
  return new URL(raw, "http://offline.local");
}

/** Parse a request's JSON body (the clients always send a `JSON.stringify`'d string). */
function readJson<T>(init?: RequestInit): T {
  const body = init?.body;
  return typeof body === "string" ? (JSON.parse(body) as T) : ({} as T);
}

/** The offline service health: always `ok`, with no database (an in-browser repo). */
function offlineHealth(): HealthStatus {
  return {
    status: "ok",
    service: "stout",
    database: false,
    migration: 0,
    timestamp: new Date().toISOString(),
  };
}

/** Clamp a `?limit=` query param into the contract's range, defaulting when absent/invalid. */
function clampLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_SEARCH_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SEARCH_LIMIT;
  return Math.min(parsed, MAX_SEARCH_LIMIT);
}

/** Run the keyword search over the whole corpus (the offline runtime has no embedder). */
async function offlineSearch(
  engine: GitEngine,
  params: URLSearchParams,
): Promise<SearchResponse> {
  const query = params.get("q") ?? "";
  const notes = await readSearchableNotes(engine);
  return {
    query: query.trim(),
    mode: "keyword",
    results: keywordSearch(query, notes, clampLimit(params.get("limit"))),
  };
}

/**
 * Adapt a {@link WritableGitEngine} into the {@link WipSyncEngine} the core
 * {@link applyNoteSync} dispatcher drives — the offline counterpart to the
 * server's full wip-branch engine.
 *
 * A purely local PWA is a single writer with no remote, so there is no value in
 * ephemeral wip branches: an `autosave` commits straight to `main` (crash-safe
 * commit-on-save), and `squash` / `delete-wip` are no-ops (the work is already
 * on `main`). The note's wip ref is still computed purely so the response shape
 * matches the server's.
 */
export function createCommitOnSaveWipEngine(engine: WritableGitEngine): WipSyncEngine {
  return {
    wipBranchName,
    async commitToWip(notePath, markdown) {
      await writeNote(engine, notePath, markdown);
    },
    async squashMergeWipToMain() {
      // No-op: the autosave already committed to `main` in the offline runtime.
    },
    async deleteWip() {
      // No-op: there is no separate wip branch to delete offline.
    },
  };
}

/**
 * Build the in-browser `fetch` that backs the offline App. Routes each `/api/*`
 * request to the matching `@stout/core` composition over `engine`, returning a
 * real {@link Response} so the existing `App` hooks and `*-client.ts` adapters
 * work unchanged. Unknown routes 404; mutations/attachments 501 (graceful);
 * unexpected engine errors 500.
 */
export function createBrowserApiFetch(engine: WritableGitEngine): typeof fetch {
  const wipEngine = createCommitOnSaveWipEngine(engine);

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = toUrl(input);
    const path = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    try {
      if (method === "GET") {
        if (path === HEALTH_PATH) return json(offlineHealth());
        if (path === TREE_PATH) return json(await readNoteTree(engine));
        if (path === LINKS_PATH) return json(await readLinkGraph(engine));
        if (path === SEARCH_PATH) return json(await offlineSearch(engine, url.searchParams));
        if (path === NOTE_PATH) {
          const note = await readNote(engine, url.searchParams.get("path") ?? "");
          return note === null ? json({ error: "note not found" }, 404) : json(note);
        }
      }

      if (method === "POST") {
        if (path === SYNC_PATH) {
          return json(await applyNoteSync(wipEngine, readJson(init)));
        }
        if (path === NOTE_PATH) {
          const body = readJson<Partial<NoteSaveRequest>>(init);
          if (typeof body.markdown !== "string") {
            return json({ error: "markdown is required" }, 400);
          }
          return json(await writeNote(engine, body.path ?? "", body.markdown));
        }
        if (path === NOTE_CREATE_PATH || path === NOTE_RENAME_PATH || path === NOTE_MOVE_PATH) {
          return json(
            { error: "Note create/rename/move is not available offline yet." },
            501,
          );
        }
        if (path === ATTACHMENT_PATH) {
          return json({ error: "Attachments are not available offline yet." }, 501);
        }
      }

      return json({ error: `No offline route for ${method} ${path}` }, 404);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  };
}
