/**
 * The attachment (embedded media) contract.
 *
 * Stout keeps notes self-contained and portable: an embedded image or file is
 * stored as a real file in the repository — under a conventional {@link ASSETS_DIR}
 * folder — and referenced from Markdown by a repo-relative path
 * (`![alt](assets/diagram.png)`). This module owns the pure pieces of that
 * contract: the REST path, the request/response shapes, the name → safe file-slug
 * function, and the {@link writeAttachment} composition over a narrow
 * {@link AttachmentGitEngine} seam. The Node/Git side (decode bytes, write the
 * file, commit, guarantee a unique name) is a thin, injectable implementation in
 * `apps/server`, mirroring how {@link writeNote} sits over `WritableGitEngine`.
 */

/** Conventional folder (repo-relative) that holds embedded media. */
export const ASSETS_DIR = "assets" as const;

/** REST path of the attachment-upload endpoint (`POST`). */
export const ATTACHMENT_PATH = "/api/attachment" as const;

/**
 * Request body of `POST /api/attachment` — upload one binary attachment.
 *
 * The bytes travel base64-encoded (`dataBase64`) so the upload is a plain JSON
 * POST with no multipart handling; the server decodes it before writing.
 */
export interface AttachmentUploadRequest {
  /** Original file name; slugified (extension preserved) into the stored name. */
  name: string;
  /** The file's bytes, base64-encoded. */
  dataBase64: string;
}

/** Response body of a successful `POST /api/attachment`. */
export interface AttachmentResponse {
  /**
   * Repo-relative POSIX path the attachment was stored at, e.g.
   * `assets/diagram.png` — the exact string to reference from a note's Markdown.
   * May differ from the requested name when a collision forced a unique suffix.
   */
  path: string;
}

/**
 * Turn an uploaded file name into a safe, kebab-case slug that **keeps its
 * extension**.
 *
 * Pure and deterministic: the base name is lowercased with every run of
 * non-alphanumeric characters collapsed to a single dash (mirroring
 * `slugifyNoteName`), and the extension is lowercased and stripped of any
 * non-alphanumeric characters. A base with no usable characters falls back to
 * `file`, so `"My Diagram.PNG"` → `"my-diagram.png"` and `"???.jpg"` →
 * `"file.jpg"`. A name with no extension yields just the base slug.
 */
export function slugifyAttachmentName(name: string): string {
  const dot = name.lastIndexOf(".");
  const hasExtension = dot > 0 && dot < name.length - 1;
  const base = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot + 1) : "";

  const baseSlug =
    base
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "file";
  const extensionSlug = extension.toLowerCase().replace(/[^a-z0-9]+/gu, "");

  return extensionSlug ? `${baseSlug}.${extensionSlug}` : baseSlug;
}

/**
 * A seam that writes one attachment's bytes into the working clone and commits
 * it, returning the **final** repo-relative path actually used.
 *
 * The engine owns collision resolution (appending a `-1`, `-2`, … suffix when the
 * desired path is taken) because uniqueness depends on what is already on disk —
 * an IO concern. Keeping the write behind an interface lets {@link writeAttachment}
 * be tested against an in-memory double, mirroring `WritableGitEngine`.
 */
export interface AttachmentGitEngine {
  /**
   * Write `bytes` near `desiredPath` (repo-relative POSIX, e.g.
   * `assets/diagram.png`) in the working clone and commit it with `message`.
   * Implementations must guard against path escapes and resolve to the actual
   * path written (which may differ from `desiredPath` to stay unique).
   */
  writeAttachmentFile(
    desiredPath: string,
    bytes: Uint8Array,
    message: string,
  ): Promise<string>;
}

/**
 * Persist an uploaded attachment via the injected {@link AttachmentGitEngine}.
 *
 * Slugifies the name into `assets/<slug>` and delegates the write/commit (and
 * any collision-avoiding suffix) to the engine, returning the final stored path
 * for the client to reference. The slugging stays pure; only the write touches
 * the engine.
 */
export async function writeAttachment(
  engine: AttachmentGitEngine,
  name: string,
  bytes: Uint8Array,
): Promise<AttachmentResponse> {
  const desiredPath = `${ASSETS_DIR}/${slugifyAttachmentName(name)}`;
  const path = await engine.writeAttachmentFile(
    desiredPath,
    bytes,
    `Add attachment ${desiredPath}`,
  );
  return { path };
}
