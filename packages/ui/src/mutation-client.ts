/**
 * Browser side of the note-mutation seam (create / rename / move).
 *
 * Thin HTTP adapters over the three mutation endpoints, mirroring how
 * {@link postNoteSync} wraps the sync endpoint. Each posts its request and
 * returns the affected note's new identity so the caller can reselect it after
 * the tree reloads. The structural transitions (leaf↔parent promotion/collapse,
 * whole-subtree move) all live server-side in `core/note-mutation`; the client
 * just names the operation.
 *
 * A non-2xx response is surfaced as an `Error` carrying the server's message
 * (the API returns `{ error }` for a rejected mutation), so the UI can show why
 * a name was duplicate/invalid rather than failing silently.
 *
 * See `docs/adr/0005-note-mutations-and-leaf-parent-transition.md`.
 */

import {
  NOTE_CREATE_PATH,
  NOTE_MOVE_PATH,
  NOTE_RENAME_PATH,
  type NoteCreateRequest,
  type NoteMoveRequest,
  type NoteMutationResponse,
  type NoteRenameRequest,
} from "@stout/core";

/** POST a mutation request and return its response, throwing the server error message on failure. */
async function postMutation(
  path: string,
  body: NoteCreateRequest | NoteRenameRequest | NoteMoveRequest,
  fetchImpl: typeof fetch,
): Promise<NoteMutationResponse> {
  const res = await fetchImpl(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const message = await errorMessage(res);
    throw new Error(message);
  }
  return (await res.json()) as NoteMutationResponse;
}

/** Best-effort extraction of the server's `{ error }` message (falls back to the status). */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Non-JSON body; fall through to the status line.
  }
  return `HTTP ${res.status}`;
}

/** Create a new leaf note named `name` under `parent` (root is `""`). */
export function postNoteCreate(
  parent: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NoteMutationResponse> {
  return postMutation(NOTE_CREATE_PATH, { parent, name }, fetchImpl);
}

/** Rename the note at `path` in place (whole subtree for a parent). */
export function postNoteRename(
  path: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NoteMutationResponse> {
  return postMutation(NOTE_RENAME_PATH, { path, name }, fetchImpl);
}

/** Move the note at `path` under `parent` (root is `""`). */
export function postNoteMove(
  path: string,
  parent: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NoteMutationResponse> {
  return postMutation(NOTE_MOVE_PATH, { path, parent }, fetchImpl);
}
