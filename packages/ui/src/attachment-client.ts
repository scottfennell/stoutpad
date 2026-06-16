/**
 * Browser side of the attachment-upload seam.
 *
 * A thin HTTP adapter over `POST /api/attachment`, mirroring how
 * {@link postNoteCreate} and friends wrap the mutation endpoints. The file's
 * bytes travel base64-encoded in a plain JSON body (no multipart), and the
 * server replies with the repo-relative path the attachment was stored at —
 * which may differ from the uploaded name when a collision forced a unique
 * suffix. The caller embeds that path in the note's Markdown as `![alt](path)`.
 *
 * A non-2xx response is surfaced as an `Error` carrying the server's `{ error }`
 * message, so the UI can explain a rejected upload rather than failing silently.
 *
 * See `docs/adr/0007-frontmatter-tags-attachments.md`.
 */

import {
  ATTACHMENT_PATH,
  type AttachmentResponse,
  type AttachmentUploadRequest,
} from "@stout/core";

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

/**
 * Upload one binary attachment (its bytes already base64-encoded) and return the
 * stored repo-relative path, throwing the server's error message on failure.
 */
export async function postAttachment(
  name: string,
  dataBase64: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AttachmentResponse> {
  const body: AttachmentUploadRequest = { name, dataBase64 };
  const res = await fetchImpl(ATTACHMENT_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  return (await res.json()) as AttachmentResponse;
}
