/**
 * Browser side of the autosave sync seam.
 *
 * The core {@link NoteSync} state machine drives a {@link WipSyncEngine}; in the
 * browser that engine is this thin HTTP adapter, mapping each wip-branch
 * operation to one `POST /api/note/sync` action. So the exact same state machine
 * that the server drives over real Git runs in the client over fetch — debounce,
 * squash triggers, and "never push" all live in `core/sync`, not here.
 *
 * See `docs/adr/0004-autosave-wip-squash.md`.
 */

import {
  SYNC_PATH,
  wipBranchName,
  type NoteSyncRequest,
  type NoteSyncResponse,
  type WipSyncEngine,
} from "@stout/core";

/**
 * Send one wip-branch sync action to `POST /api/note/sync`. Uses `keepalive` so
 * a squash fired during tab-hide/unload still has a chance to reach the server.
 */
export async function postNoteSync(
  request: NoteSyncRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<NoteSyncResponse> {
  const res = await fetchImpl(SYNC_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    keepalive: true,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as NoteSyncResponse;
}

/**
 * A {@link WipSyncEngine} that performs each wip-branch operation as an HTTP
 * call. The wip ref is computed purely (so it matches the server's), while
 * commit/squash/delete each post their action. There is, by construction, no
 * push: wip branches stay local to the server's clone.
 */
export function createHttpWipEngine(fetchImpl: typeof fetch = fetch): WipSyncEngine {
  return {
    wipBranchName,
    async commitToWip(notePath, markdown) {
      await postNoteSync({ path: notePath, action: "autosave", markdown }, fetchImpl);
    },
    async squashMergeWipToMain(notePath, message) {
      await postNoteSync({ path: notePath, action: "squash", message }, fetchImpl);
    },
    async deleteWip(notePath) {
      await postNoteSync({ path: notePath, action: "delete-wip" }, fetchImpl);
    },
  };
}
