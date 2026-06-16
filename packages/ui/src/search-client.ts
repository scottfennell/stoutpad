/**
 * Browser side of the search seam.
 *
 * A thin HTTP adapter over the read-only search endpoint, mirroring how the
 * other `*-client.ts` modules wrap their API. It serializes a {@link SearchRequest}
 * into the `GET /api/search?q=&limit=&mode=` query string and returns the ranked
 * {@link SearchResponse}. All ranking (semantic + the automatic keyword fallback)
 * lives server-side in `core/search-index`; the client only names the query.
 *
 * See `docs/adr/0008-semantic-search.md`.
 */

import {
  SEARCH_PATH,
  type SearchRequest,
  type SearchResponse,
} from "@stout/core";

/**
 * Run a search via `GET /api/search`. Returns the ranked results plus the mode
 * the server actually used (semantic or the keyword fallback). Throws on a
 * non-2xx response so the caller can surface the failure.
 */
export async function getSearch(
  request: SearchRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: request.query });
  if (request.limit !== undefined) params.set("limit", String(request.limit));
  if (request.mode !== undefined) params.set("mode", request.mode);
  const res = await fetchImpl(`${SEARCH_PATH}?${params.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SearchResponse;
}
