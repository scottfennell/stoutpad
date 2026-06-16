import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildTitleIndex,
  DEFAULT_DEBOUNCE_MS,
  deriveTitle,
  HEALTH_PATH,
  NOTE_PATH,
  NoteSync,
  parseMarkdown,
  resolveTitle,
  serializeMarkdown,
  TREE_PATH,
  type Frontmatter,
  type HealthStatus,
  type NoteContentResponse,
  type NoteNode,
  type NoteTreeResponse,
  type SearchResponse,
  type SearchResult,
} from "@stout/core";
import { TipTapEditor } from "./TipTapEditor.js";
import { createHttpWipEngine } from "./sync-client.js";
import { postAttachment } from "./attachment-client.js";
import { getSearch } from "./search-client.js";
import { postNoteCreate, postNoteMove, postNoteRename } from "./mutation-client.js";
import type { EditorComponent, WikiLinkContext } from "./editor.js";

type Fetched =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; health: HealthStatus };

export function useHealth(fetchImpl: typeof fetch = fetch): Fetched {
  const [result, setResult] = useState<Fetched>({ state: "loading" });

  useEffect(() => {
    let active = true;
    fetchImpl(HEALTH_PATH)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<HealthStatus>;
      })
      .then((health) => {
        if (active) setResult({ state: "ready", health });
      })
      .catch((err: unknown) => {
        if (active)
          setResult({
            state: "error",
            message: err instanceof Error ? err.message : String(err),
          });
      });
    return () => {
      active = false;
    };
  }, [fetchImpl]);

  return result;
}

type TreeFetched =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; tree: NoteTreeResponse };

/**
 * Fetch the unified note tree. `reloadToken` is an opaque value the caller bumps
 * to force a refetch after a mutation (create / rename / move) reshapes the tree.
 */
export function useTree(
  fetchImpl: typeof fetch = fetch,
  reloadToken: number = 0,
): TreeFetched {
  const [result, setResult] = useState<TreeFetched>({ state: "loading" });

  useEffect(() => {
    let active = true;
    fetchImpl(TREE_PATH)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<NoteTreeResponse>;
      })
      .then((tree) => {
        if (active) setResult({ state: "ready", tree });
      })
      .catch((err: unknown) => {
        if (active)
          setResult({
            state: "error",
            message: err instanceof Error ? err.message : String(err),
          });
      });
    return () => {
      active = false;
    };
  }, [fetchImpl, reloadToken]);

  return result;
}

type NoteFetched =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; note: NoteContentResponse };

/**
 * Fetch a note's content by identity. `path` is the note's tree `path` (the root
 * note is `""`); `null` means "nothing selected" and yields the idle state.
 */
export function useNote(
  path: string | null,
  fetchImpl: typeof fetch = fetch,
): NoteFetched {
  const [result, setResult] = useState<NoteFetched>(
    path === null ? { state: "idle" } : { state: "loading" },
  );

  useEffect(() => {
    if (path === null) {
      setResult({ state: "idle" });
      return;
    }
    let active = true;
    setResult({ state: "loading" });
    fetchImpl(`${NOTE_PATH}?path=${encodeURIComponent(path)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<NoteContentResponse>;
      })
      .then((note) => {
        if (active) setResult({ state: "ready", note });
      })
      .catch((err: unknown) => {
        if (active)
          setResult({
            state: "error",
            message: err instanceof Error ? err.message : String(err),
          });
      });
    return () => {
      active = false;
    };
  }, [path, fetchImpl]);

  return result;
}

/**
 * Search debounce (ms): how long the box must be idle before a query is sent.
 * Shorter than the autosave debounce — search should feel responsive — but long
 * enough to coalesce a burst of keystrokes into a single request.
 */
const SEARCH_DEBOUNCE_MS = 150;

type SearchFetched =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; response: SearchResponse };

/**
 * Debounced note search. An empty/whitespace query is inert — it never hits the
 * network and resolves to the idle state — so the index is only queried once the
 * user has actually typed something and paused. Each keystroke restarts the
 * debounce; a superseded or unmounted query is ignored. Ranking (semantic with
 * an automatic keyword fallback) lives server-side; this only sends the query.
 */
export function useSearch(
  query: string,
  options: { debounceMs?: number; fetchImpl?: typeof fetch } = {},
): SearchFetched {
  const { debounceMs = SEARCH_DEBOUNCE_MS, fetchImpl } = options;
  const [result, setResult] = useState<SearchFetched>({ state: "idle" });

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setResult({ state: "idle" });
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      setResult({ state: "loading" });
      getSearch({ query: trimmed }, fetchImpl ?? fetch)
        .then((response) => {
          if (active) setResult({ state: "ready", response });
        })
        .catch((err: unknown) => {
          if (active)
            setResult({
              state: "error",
              message: err instanceof Error ? err.message : String(err),
            });
        });
    }, debounceMs);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, debounceMs, fetchImpl]);

  return result;
}

/**
 * Wire the editor to the autosave + wip-squash {@link NoteSync} state machine.
 *
 * Returns the editor's `onChange` handler. Each change buffers the edit and
 * (re)starts a real debounce timer; when it fires, the edit is flushed to the
 * note's `wip/<note>` branch (`POST /api/note/sync`). The session is squash-
 * merged into `main` when focus leaves — the tab blurs, the page is hidden or
 * unloaded, or the note is switched/unmounted — yielding one commit per editing
 * session. Crash-safe: edits live as wip commits before any squash. When
 * `notePath` is `null` (nothing loaded) the handler is inert.
 */
export function useNoteSync(
  notePath: string | null,
  initialMarkdown: string,
  options: { debounceMs?: number; fetchImpl?: typeof fetch } = {},
): (markdown: string) => void {
  const { debounceMs = DEFAULT_DEBOUNCE_MS, fetchImpl } = options;
  const engine = useMemo(() => createHttpWipEngine(fetchImpl ?? fetch), [fetchImpl]);
  const syncRef = useRef<NoteSync | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  // One session per loaded note. Ending it (here, and on the session-end events)
  // flushes any buffered edit and squashes the wip branch into `main`; the core
  // machine makes a redundant end a no-op, so overlapping triggers are safe.
  useEffect(() => {
    if (notePath === null) {
      syncRef.current = null;
      return;
    }
    const sync = new NoteSync(engine, notePath, { debounceMs, initialMarkdown });
    syncRef.current = sync;

    const endSession = (): void => {
      clearTimer();
      void sync.onFocusLeave().catch(() => undefined);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") endSession();
    };
    window.addEventListener("blur", endSession);
    window.addEventListener("pagehide", endSession);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.removeEventListener("blur", endSession);
      window.removeEventListener("pagehide", endSession);
      document.removeEventListener("visibilitychange", onVisibility);
      // Switching notes or unmounting ends (and squashes) the current session.
      endSession();
      syncRef.current = null;
    };
  }, [engine, notePath, initialMarkdown, debounceMs, clearTimer]);

  return useCallback(
    (markdown: string) => {
      const sync = syncRef.current;
      if (sync === null) return;
      sync.onEdit(markdown);
      clearTimer();
      timer.current = setTimeout(() => {
        timer.current = null;
        void sync.flush().catch(() => undefined);
      }, debounceMs);
    },
    [debounceMs, clearTimer],
  );
}

/** A note-tree mutation requested from a node's affordances. */
type TreeMutation = "create" | "rename" | "move";

const ACTION_BUTTON_STYLE = {
  appearance: "none",
  background: "transparent",
  border: "none",
  color: "#9aa0a3",
  cursor: "pointer",
  font: "inherit",
  fontSize: "0.8em",
  padding: "0 0.25rem",
} as const;

function NoteTreeItem({
  node,
  selectedPath,
  onSelect,
  onMutate,
}: {
  node: NoteNode;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onMutate: (kind: TreeMutation, node: NoteNode) => void;
}) {
  const isSelected = selectedPath === node.path;
  const isRoot = node.path === "";
  return (
    <li>
      <span style={{ display: "flex", alignItems: "center", gap: "0.15rem" }}>
        <button
          type="button"
          data-testid="note-title"
          aria-current={isSelected ? "true" : undefined}
          onClick={() => onSelect(node.path)}
          style={{
            appearance: "none",
            background: isSelected ? "#2b2f31" : "transparent",
            border: "none",
            color: "inherit",
            cursor: "pointer",
            font: "inherit",
            flex: 1,
            padding: "0.15rem 0.35rem",
            textAlign: "left",
          }}
        >
          {node.title}
        </button>
        <button
          type="button"
          aria-label={`New note under ${node.title}`}
          title="New child note"
          onClick={() => onMutate("create", node)}
          style={ACTION_BUTTON_STYLE}
        >
          +
        </button>
        {!isRoot && (
          <>
            <button
              type="button"
              aria-label={`Rename ${node.title}`}
              title="Rename note"
              onClick={() => onMutate("rename", node)}
              style={ACTION_BUTTON_STYLE}
            >
              ✎
            </button>
            <button
              type="button"
              aria-label={`Move ${node.title}`}
              title="Move note"
              onClick={() => onMutate("move", node)}
              style={ACTION_BUTTON_STYLE}
            >
              ⇄
            </button>
          </>
        )}
      </span>
      {node.children.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, paddingLeft: "1rem" }}>
          {node.children.map((child) => (
            <NoteTreeItem
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onMutate={onMutate}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function NavPanel({
  treeResult,
  selectedPath,
  onSelect,
  onReload,
}: {
  treeResult: TreeFetched;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onReload: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const handleMutate = useCallback(
    (kind: TreeMutation, node: NoteNode) => {
      const run = async (): Promise<void> => {
        if (kind === "create") {
          const name = window.prompt(`New note under "${node.title || "Home"}"`);
          if (name === null || name.trim() === "") return;
          return select(await postNoteCreate(node.path, name));
        }
        if (kind === "rename") {
          const name = window.prompt(`Rename "${node.title}" to`, node.title);
          if (name === null || name.trim() === "") return;
          return select(await postNoteRename(node.path, name));
        }
        const parent = window.prompt(
          `Move "${node.title}" under which note? (blank = Home)`,
        );
        if (parent === null) return;
        return select(await postNoteMove(node.path, parent.trim()));
      };
      // Reselect the affected note and refetch the (reshaped) tree on success;
      // surface a rejected mutation (duplicate/invalid name, illegal move) inline.
      const select = (res: { path: string }): void => {
        setError(null);
        onSelect(res.path);
        onReload();
      };
      run().catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    },
    [onSelect, onReload],
  );

  return (
    <nav
      aria-label="Notes"
      style={{
        flex: "0 0 16rem",
        borderRight: "1px solid #50453b",
        padding: "1.5rem",
        background: "#191c1d",
        color: "#e1e3e4",
      }}
    >
      <h2 style={{ fontSize: "0.75rem", letterSpacing: "0.05em", textTransform: "uppercase" }}>
        Notes
      </h2>
      {error !== null && (
        <p role="alert" style={{ color: "#e6a3a3" }}>
          {error}
        </p>
      )}
      {treeResult.state === "loading" && <p>Loading notes…</p>}
      {treeResult.state === "error" && (
        <p role="alert">Could not load notes: {treeResult.message}</p>
      )}
      {treeResult.state === "ready" && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          <NoteTreeItem
            node={treeResult.tree.root}
            selectedPath={selectedPath}
            onSelect={onSelect}
            onMutate={handleMutate}
          />
        </ul>
      )}
    </nav>
  );
}

/** One ranked search hit: the note's title over a snippet; click to open it. */
function SearchResultItem({
  result,
  onSelect,
}: {
  result: SearchResult;
  onSelect: (path: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-testid="search-result"
        data-result-path={result.path}
        onClick={() => onSelect(result.path)}
        style={{
          appearance: "none",
          background: "transparent",
          border: "none",
          color: "inherit",
          cursor: "pointer",
          font: "inherit",
          display: "block",
          width: "100%",
          textAlign: "left",
          padding: "0.35rem 0.5rem",
          borderRadius: "0.25rem",
        }}
      >
        <span style={{ display: "block", color: "#f2be8c" }}>
          {result.title || "Home"}
        </span>
        <span style={{ display: "block", fontSize: "0.8em", color: "#9aa0a3" }}>
          {result.snippet}
        </span>
      </button>
    </li>
  );
}

/**
 * The search box and its ranked results. Typing queries the index (debounced);
 * clicking a result opens that note in the center panel. The result list reports
 * which ranking actually ran (semantic, or the keyword fallback) so a degraded
 * model is visible rather than silent.
 */
function SearchPanel({
  onSelect,
  debounceMs,
}: {
  onSelect: (path: string) => void;
  debounceMs?: number;
}) {
  const [query, setQuery] = useState("");
  const result = useSearch(query, { debounceMs });

  return (
    <section aria-label="Search" style={{ marginBottom: "1.5rem" }}>
      <input
        type="search"
        aria-label="Search notes"
        placeholder="Search notes…"
        data-testid="search-input"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "0.4rem 0.6rem",
          background: "#191c1d",
          border: "1px solid #50453b",
          borderRadius: "0.25rem",
          color: "#e1e3e4",
          font: "inherit",
        }}
      />
      {result.state === "loading" && <p data-testid="search-status">Searching…</p>}
      {result.state === "error" && (
        <p role="alert">Search failed: {result.message}</p>
      )}
      {result.state === "ready" && (
        <div data-testid="search-results">
          {result.response.results.length === 0 ? (
            <p data-testid="search-empty">No matches.</p>
          ) : (
            <>
              <p
                style={{
                  fontSize: "0.7rem",
                  color: "#9aa0a3",
                  margin: "0.5rem 0 0.25rem",
                }}
              >
                {result.response.results.length} result
                {result.response.results.length === 1 ? "" : "s"} ·{" "}
                <span data-testid="search-mode">{result.response.mode}</span>
              </p>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {result.response.results.map((hit) => (
                  <SearchResultItem key={hit.path} result={hit} onSelect={onSelect} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function NotePanel({
  selectedPath,
  Editor,
  debounceMs,
  wikiLinks,
}: {
  selectedPath: string | null;
  Editor: EditorComponent;
  debounceMs?: number;
  wikiLinks?: WikiLinkContext;
}) {
  const result = useNote(selectedPath);

  return (
    <section aria-label="Note" style={{ marginBottom: "2rem" }}>
      {result.state === "idle" && (
        <p data-testid="note-empty">Select a note to open it.</p>
      )}
      {result.state === "loading" && <p>Loading note…</p>}
      {result.state === "error" && (
        <p role="alert">Could not load note: {result.message}</p>
      )}
      {result.state === "ready" && (
        // Keyed on the note identity so switching notes remounts the editor with
        // fresh draft state and ends the prior autosave session.
        <LoadedNote
          key={result.note.path}
          note={result.note}
          Editor={Editor}
          debounceMs={debounceMs}
          wikiLinks={wikiLinks}
        />
      )}
    </section>
  );
}

/** Split a note's full Markdown into its frontmatter and frontmatter-free body. */
function splitFrontmatter(full: string): {
  frontmatter?: Frontmatter;
  body: string;
} {
  const doc = parseMarkdown(full);
  return {
    frontmatter: doc.frontmatter,
    body: serializeMarkdown({ blocks: doc.blocks }),
  };
}

/** Recombine the (unchanged) frontmatter with an edited body into full Markdown. */
function recomposeNote(
  frontmatter: Frontmatter | undefined,
  body: string,
): string {
  return serializeMarkdown({ frontmatter, blocks: parseMarkdown(body).blocks });
}

/** The note's display title: its frontmatter `title`, else derived from its path. */
function displayTitle(path: string, frontmatter?: Frontmatter): string {
  if (frontmatter?.title) return frontmatter.title;
  if (path === "") return "Home";
  return deriveTitle(path.slice(path.lastIndexOf("/") + 1));
}

/** A file name without its extension, for an embedded image's alt text. */
function altText(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Append an embedded-image Markdown block referencing `storagePath` to `body`. */
function appendImage(body: string, storagePath: string, name: string): string {
  const image = `![${altText(name)}](${storagePath})`;
  const trimmed = body.replace(/\n+$/u, "");
  return trimmed.length > 0 ? `${trimmed}\n\n${image}\n` : `${image}\n`;
}

/** Read a File's bytes as a base64 string (the data-URL prefix stripped). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = reader.result;
      if (typeof data !== "string") {
        reject(new Error("could not read file"));
        return;
      }
      const comma = data.indexOf(",");
      resolve(comma >= 0 ? data.slice(comma + 1) : data);
    };
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

/** The note's metadata header: its display title plus its tags rendered as chips. */
function NoteHeader({ title, tags }: { title: string; tags: string[] }) {
  return (
    <header style={{ marginBottom: "1.25rem" }}>
      <h1
        data-testid="note-title-heading"
        style={{ margin: "0 0 0.75rem", fontSize: "1.75rem", color: "#f2be8c" }}
      >
        {title}
      </h1>
      {tags.length > 0 && (
        <div
          data-testid="note-tags"
          style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}
        >
          {tags.map((tag) => (
            <span
              key={tag}
              data-testid="note-tag"
              style={{
                padding: "0.2rem 0.5rem",
                borderRadius: "0.25rem",
                fontSize: "0.75rem",
                color: "#a6caff",
                background: "rgba(113,175,255,0.1)",
                border: "1px solid rgba(166,202,255,0.25)",
              }}
            >
              #{tag}
            </span>
          ))}
        </div>
      )}
    </header>
  );
}

/** File-picker affordance that uploads an image attachment and reports errors. */
function AttachmentUpload({
  onUpload,
  error,
}: {
  onUpload: (file: File) => void;
  error: string | null;
}) {
  return (
    <div style={{ marginBottom: "1rem" }}>
      <label
        style={{
          display: "inline-block",
          cursor: "pointer",
          padding: "0.25rem 0.6rem",
          borderRadius: "0.25rem",
          border: "1px solid #50453b",
          color: "#d4c4b7",
          fontSize: "0.8rem",
        }}
      >
        Attach image
        <input
          type="file"
          accept="image/*"
          data-testid="attachment-input"
          style={{ display: "none" }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onUpload(file);
          }}
        />
      </label>
      {error !== null && (
        <span role="alert" style={{ color: "#e6a3a3", marginLeft: "0.5rem" }}>
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Render a loaded note: its frontmatter as a header (title + tag chips), an
 * attachment uploader, and the editor over the frontmatter-free body. The body
 * is held as local draft state so an uploaded image can be appended and shown
 * live; every change recombines the frontmatter and drives the autosave session.
 */
function LoadedNote({
  note,
  Editor,
  debounceMs,
  wikiLinks,
}: {
  note: NoteContentResponse;
  Editor: EditorComponent;
  debounceMs?: number;
  wikiLinks?: WikiLinkContext;
}) {
  const { frontmatter, body: initialBody } = useMemo(
    () => splitFrontmatter(note.markdown),
    [note.markdown],
  );
  const [body, setBody] = useState(initialBody);
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Drive the autosave/squash session off the loaded note's full Markdown.
  const onSync = useNoteSync(note.path, note.markdown, { debounceMs });
  const emitChange = useCallback(
    (nextBody: string) => onSync(recomposeNote(frontmatter, nextBody)),
    [onSync, frontmatter],
  );

  const handleEditorChange = useCallback(
    (nextBody: string) => {
      setBody(nextBody);
      emitChange(nextBody);
    },
    [emitChange],
  );

  const handleUpload = useCallback(
    (file: File) => {
      void (async () => {
        try {
          const dataBase64 = await fileToBase64(file);
          const { path } = await postAttachment(file.name, dataBase64);
          // Read the latest body off the ref: the upload is async, so the user
          // may have edited since it started.
          const next = appendImage(bodyRef.current, path, file.name);
          setBody(next);
          emitChange(next);
          setUploadError(null);
        } catch (err) {
          setUploadError(err instanceof Error ? err.message : String(err));
        }
      })();
    },
    [emitChange],
  );

  return (
    <article data-testid="note-content" data-note-path={note.path}>
      <NoteHeader
        title={displayTitle(note.path, frontmatter)}
        tags={frontmatter?.tags ?? []}
      />
      <AttachmentUpload onUpload={handleUpload} error={uploadError} />
      <Editor markdown={body} onChange={handleEditorChange} wikiLinks={wikiLinks} />
    </article>
  );
}

export interface AppProps {
  /** Swappable editor seam; defaults to the TipTap implementation. */
  Editor?: EditorComponent;
  /**
   * Idle debounce (ms) before a buffered edit is autosaved to the note's wip
   * branch, and before a typed search query is sent. Defaults to
   * {@link DEFAULT_DEBOUNCE_MS} for autosave / {@link SEARCH_DEBOUNCE_MS} for
   * search; tests pass a small value for determinism.
   */
  debounceMs?: number;
}

export function App({ Editor = TipTapEditor, debounceMs }: AppProps = {}) {
  const health = useHealth();
  const [selected, setSelected] = useState<string | null>(null);
  // The note tree is fetched once here and shared by the nav (rendering) and the
  // editor (wikilink resolution). Bumping the token refetches it after a mutation.
  const [reloadToken, setReloadToken] = useState(0);
  const treeResult = useTree(fetch, reloadToken);
  const reloadTree = useCallback(() => setReloadToken((token) => token + 1), []);

  // Resolve `[[wikilinks]]` against the loaded tree, entirely client-side: build a
  // title index once per tree and hand the editor a resolver, the autocomplete
  // titles, and a navigate-to-note callback. Undefined until the tree is ready, so
  // links render as plain text during load.
  const wikiLinks = useMemo<WikiLinkContext | undefined>(() => {
    if (treeResult.state !== "ready") return undefined;
    const index = buildTitleIndex(treeResult.tree.root);
    return {
      titles: index.titles,
      resolve: (target) => resolveTitle(index, target),
      onNavigate: (path) => setSelected(path),
    };
  }, [treeResult]);

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        fontFamily: "ui-monospace, monospace",
      }}
    >
      <NavPanel
        treeResult={treeResult}
        selectedPath={selected}
        onSelect={setSelected}
        onReload={reloadTree}
      />
      <main style={{ flex: 1, padding: "2rem" }}>
        <h1>Stout</h1>
        <SearchPanel onSelect={setSelected} debounceMs={debounceMs} />
        <NotePanel
          selectedPath={selected}
          Editor={Editor}
          debounceMs={debounceMs}
          wikiLinks={wikiLinks}
        />
        <section>
          <h2>Service health</h2>
          {health.state === "loading" && <p>Checking health…</p>}
          {health.state === "error" && (
            <p role="alert">Health check failed: {health.message}</p>
          )}
          {health.state === "ready" && (
            <dl>
              <dt>Status</dt>
              <dd data-testid="status">{health.health.status}</dd>
              <dt>Database</dt>
              <dd data-testid="database">
                {health.health.database ? "connected" : "unavailable"}
              </dd>
              <dt>Migration</dt>
              <dd data-testid="migration">{health.health.migration}</dd>
            </dl>
          )}
        </section>
      </main>
    </div>
  );
}
