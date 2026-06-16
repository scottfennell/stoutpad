/**
 * Runtime selection for the single built SPA.
 *
 * One `dist/` is served two ways: by the Express/Electron host (the **server**
 * runtime, talking to a live `/api/*`) and as an installed **offline** PWA
 * (talking to the in-browser `BrowserGitEngine`). Rather than ship two bundles,
 * the entry (`main.tsx`) picks the runtime at load time from the page's query
 * string, so the same `index.html` boots either way.
 *
 * The PWA manifest's `start_url` carries `?runtime=offline`, so launching the
 * installed app boots the offline runtime; the web app served at `/` (no such
 * query) keeps the server runtime, unchanged. See ADR 0011.
 */

/** Which backend the SPA should boot against. */
export type RuntimeMode = "server" | "offline";

/**
 * Decide the {@link RuntimeMode} from a location search string (e.g.
 * `window.location.search`). Only an explicit `?runtime=offline` selects the
 * offline runtime; everything else — including no query — defaults to `server`,
 * so the server-backed web app is never accidentally switched.
 */
export function resolveRuntimeMode(search: string): RuntimeMode {
  return new URLSearchParams(search).get("runtime") === "offline"
    ? "offline"
    : "server";
}
