import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildTitleIndex,
  DEFAULT_DEBOUNCE_MS,
  deriveTitle,
  HEALTH_PATH,
  LINKS_PATH,
  NOTE_PATH,
  NoteSync,
  parseInline,
  parseMarkdown,
  resolveTitle,
  serializeMarkdown,
  TREE_PATH,
  type ConflictNotification,
  type Frontmatter,
  type HealthStatus,
  type LinkGraph,
  type LinkGraphResponse,
  type NoteContentResponse,
  type NoteNode,
  type NoteTreeResponse,
  type SearchResponse,
  type SearchResult,
} from "@stout/core";
import { TipTapEditor } from "./TipTapEditor.js";
import { createHttpWipEngine } from "./sync-client.js";
import { ConflictToasts, useConflictNotifications } from "./conflict-toast.js";
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

/** The empty link graph: the inert default before `/api/links` answers. */
const EMPTY_LINK_GRAPH: LinkGraph = { edges: [], broken: [] };

/**
 * Fetch the whole-repo {@link LinkGraph} (`GET /api/links`) for the utilities
 * panel's backlinks / outbound-links view. Degrades **gracefully**: a missing or
 * failing endpoint resolves to the empty graph rather than surfacing an error, so
 * the contextual panel simply shows no links instead of breaking the workspace.
 * Refetched when `reloadToken` bumps (a mutation reshapes the graph).
 */
export function useLinks(
  fetchImpl: typeof fetch = fetch,
  reloadToken: number = 0,
): LinkGraph {
  const [graph, setGraph] = useState<LinkGraph>(EMPTY_LINK_GRAPH);

  useEffect(() => {
    let active = true;
    fetchImpl(LINKS_PATH)
      .then((res) =>
        res.ok ? (res.json() as Promise<LinkGraphResponse>) : EMPTY_LINK_GRAPH,
      )
      .then((g) => {
        if (active) setGraph(g);
      })
      .catch(() => {
        if (active) setGraph(EMPTY_LINK_GRAPH);
      });
    return () => {
      active = false;
    };
  }, [fetchImpl, reloadToken]);

  return graph;
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
      <span className="tree__row" data-selected={isSelected}>
        <button
          type="button"
          className="tree__button"
          data-testid="note-title"
          aria-current={isSelected ? "true" : undefined}
          onClick={() => onSelect(node.path)}
        >
          {node.title}
        </button>
        <span className="tree__actions">
          <button
            type="button"
            className="tree__action"
            aria-label={`New note under ${node.title}`}
            title="New child note"
            onClick={() => onMutate("create", node)}
          >
            +
          </button>
          {!isRoot && (
            <>
              <button
                type="button"
                className="tree__action"
                aria-label={`Rename ${node.title}`}
                title="Rename note"
                onClick={() => onMutate("rename", node)}
              >
                ✎
              </button>
              <button
                type="button"
                className="tree__action"
                aria-label={`Move ${node.title}`}
                title="Move note"
                onClick={() => onMutate("move", node)}
              >
                ⇄
              </button>
            </>
          )}
        </span>
      </span>
      {node.children.length > 0 && (
        <ul className="tree">
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

/** The Stout brand lockup at the top of the navigation panel. */
function BrandHeader() {
  return (
    <div className="brand">
      <div className="brand__mark" aria-hidden="true">
        S
      </div>
      <div>
        <h1 className="brand__name">Stout</h1>
        <p className="brand__sub">Personal Notes</p>
      </div>
    </div>
  );
}

/**
 * The left navigation panel: brand, the "New Note" CTA (creates under the root
 * note), the search box, and the note tree with per-node create/rename/move
 * affordances. All mutations post through the mutation client, then reselect the
 * affected note and reload the (reshaped) tree.
 */
function NavPanel({
  treeResult,
  selectedPath,
  onSelect,
  onReload,
  debounceMs,
  fetchImpl,
}: {
  treeResult: TreeFetched;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onReload: () => void;
  debounceMs?: number;
  fetchImpl?: typeof fetch;
}) {
  const [error, setError] = useState<string | null>(null);

  const handleMutate = useCallback(
    (kind: TreeMutation, node: NoteNode) => {
      const run = async (): Promise<void> => {
        if (kind === "create") {
          const name = window.prompt(`New note under "${node.title || "Home"}"`);
          if (name === null || name.trim() === "") return;
          return select(await postNoteCreate(node.path, name, fetchImpl));
        }
        if (kind === "rename") {
          const name = window.prompt(`Rename "${node.title}" to`, node.title);
          if (name === null || name.trim() === "") return;
          return select(await postNoteRename(node.path, name, fetchImpl));
        }
        const parent = window.prompt(
          `Move "${node.title}" under which note? (blank = Home)`,
        );
        if (parent === null) return;
        return select(await postNoteMove(node.path, parent.trim(), fetchImpl));
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
    [onSelect, onReload, fetchImpl],
  );

  const root = treeResult.state === "ready" ? treeResult.tree.root : null;

  return (
    <aside
      className="panel panel--nav"
      data-testid="nav-panel"
      aria-label="Navigation"
    >
      <div className="nav__header">
        <BrandHeader />
        <button
          type="button"
          className="btn btn--primary"
          disabled={root === null}
          onClick={() => root && handleMutate("create", root)}
        >
          <span className="btn__icon" aria-hidden="true">
            +
          </span>
          New Note
        </button>
      </div>
      <div className="panel__scroll">
        <div className="nav__body">
          <SearchPanel onSelect={onSelect} debounceMs={debounceMs} fetchImpl={fetchImpl} />
          <nav aria-label="Notes">
            <h2 className="nav-heading">Files</h2>
            {error !== null && (
              <p role="alert" className="alert">
                {error}
              </p>
            )}
            {treeResult.state === "loading" && <p className="muted">Loading notes…</p>}
            {treeResult.state === "error" && (
              <p role="alert" className="alert">
                Could not load notes: {treeResult.message}
              </p>
            )}
            {treeResult.state === "ready" && (
              <ul className="tree">
                <NoteTreeItem
                  node={treeResult.tree.root}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                  onMutate={handleMutate}
                />
              </ul>
            )}
          </nav>
        </div>
      </div>
    </aside>
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
        className="search-result"
        data-testid="search-result"
        data-result-path={result.path}
        onClick={() => onSelect(result.path)}
      >
        <span className="search-result__title">{result.title || "Home"}</span>
        <span className="search-result__snippet">{result.snippet}</span>
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
  fetchImpl,
}: {
  onSelect: (path: string) => void;
  debounceMs?: number;
  fetchImpl?: typeof fetch;
}) {
  const [query, setQuery] = useState("");
  const result = useSearch(query, { debounceMs, fetchImpl });

  return (
    <section aria-label="Search" className="search">
      <input
        type="search"
        aria-label="Search notes"
        placeholder="Search notes…"
        data-testid="search-input"
        className="search__input"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {result.state === "loading" && (
        <p data-testid="search-status" className="search-meta">
          Searching…
        </p>
      )}
      {result.state === "error" && (
        <p role="alert" className="alert">
          Search failed: {result.message}
        </p>
      )}
      {result.state === "ready" && (
        <div data-testid="search-results" className="search-results">
          {result.response.results.length === 0 ? (
            <p data-testid="search-empty" className="search-meta">
              No matches.
            </p>
          ) : (
            <>
              <p className="search-meta">
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

/**
 * The center panel: renders the selected note (header + editor) or an empty
 * prompt. The note fetch is lifted to {@link App}, so the same result drives both
 * this panel and the contextual utilities panel.
 */
function NotePanel({
  result,
  Editor,
  debounceMs,
  wikiLinks,
  fetchImpl,
}: {
  result: NoteFetched;
  Editor: EditorComponent;
  debounceMs?: number;
  wikiLinks?: WikiLinkContext;
  fetchImpl?: typeof fetch;
}) {
  return (
    <section aria-label="Note" className="note-section">
      {result.state === "idle" && (
        <p data-testid="note-empty" className="note-empty muted">
          Select a note to open it.
        </p>
      )}
      {result.state === "loading" && <p className="note-empty muted">Loading note…</p>}
      {result.state === "error" && (
        <p role="alert" className="alert" style={{ padding: "var(--panel-padding)" }}>
          Could not load note: {result.message}
        </p>
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
          fetchImpl={fetchImpl}
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

/**
 * The note's metadata header: a mono eyebrow (kind badge + backing file path),
 * the display title, and the tags rendered as chips.
 */
function NoteHeader({
  title,
  tags,
  file,
}: {
  title: string;
  tags: string[];
  file: string | null;
}) {
  const badge = file?.endsWith("_index.md") ? "SECTION" : "NOTE";
  return (
    <header className="note-header">
      <div className="note-eyebrow">
        <span className="note-eyebrow__badge">{badge}</span>
        {file !== null && (
          <span className="note-eyebrow__path" data-testid="note-file">
            {file}
          </span>
        )}
      </div>
      <h1 data-testid="note-title-heading" className="note-title">
        {title}
      </h1>
      {tags.length > 0 && (
        <div data-testid="note-tags" className="note-tags">
          {tags.map((tag) => (
            <span key={tag} data-testid="note-tag" className="tag-chip">
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
    <div className="note-toolbar">
      <label className="attach">
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
        <span role="alert" className="attach__error">
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
  fetchImpl,
}: {
  note: NoteContentResponse;
  Editor: EditorComponent;
  debounceMs?: number;
  wikiLinks?: WikiLinkContext;
  fetchImpl?: typeof fetch;
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
  const onSync = useNoteSync(note.path, note.markdown, { debounceMs, fetchImpl });
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
          const { path } = await postAttachment(file.name, dataBase64, fetchImpl);
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
    [emitChange, fetchImpl],
  );

  return (
    <article data-testid="note-content" data-note-path={note.path}>
      <NoteHeader
        title={displayTitle(note.path, frontmatter)}
        tags={frontmatter?.tags ?? []}
        file={note.file}
      />
      <AttachmentUpload onUpload={handleUpload} error={uploadError} />
      <div className="editor-article">
        <Editor markdown={body} onChange={handleEditorChange} wikiLinks={wikiLinks} />
      </div>
    </article>
  );
}

/** A note's heading, flattened for the utilities-panel outline. */
interface OutlineEntry {
  level: number;
  text: string;
}

/** Strip inline Markdown markers from a heading's text (`**Bold**` → `Bold`). */
function inlinePlainText(text: string): string {
  return parseInline(text)
    .map((span) => span.text)
    .join("");
}

/** Flatten a note's headings into an outline (table of contents). Pure. */
function noteOutline(markdown: string): OutlineEntry[] {
  return parseMarkdown(markdown).blocks.flatMap((block) =>
    block.type === "heading"
      ? [{ level: block.level, text: inlinePlainText(block.text) }]
      : [],
  );
}

/** Find a note in the tree by its identity `path`, or `null` if absent. */
function findNode(node: NoteNode, path: string): NoteNode | null {
  if (node.path === path) return node;
  for (const child of node.children) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return null;
}

/** Map every note's identity `path` → display title, for link rows. */
function pathTitleMap(root: NoteNode): Map<string, string> {
  const map = new Map<string, string>();
  const visit = (node: NoteNode): void => {
    map.set(node.path, node.title);
    node.children.forEach(visit);
  };
  visit(root);
  return map;
}

/** A single key/value row in the utilities-panel "Details" section. */
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row" data-testid="utility-detail">
      <span className="detail-row__key">{label}</span>
      <span className="detail-row__value">{value}</span>
    </div>
  );
}

/** Identity / backing file / kind of the selected note, from the tree. */
function DetailsSection({
  node,
  selected,
}: {
  node: NoteNode | null;
  selected: string;
}) {
  return (
    <section aria-label="Details" className="utility-section">
      <h3 className="utility-section__heading">Details</h3>
      <div>
        <Detail label="Identity" value={selected === "" ? "(root)" : selected} />
        <Detail label="File" value={node?.file ?? "—"} />
        <Detail label="Kind" value={node?.kind ?? "—"} />
        {node?.kind === "parent" && (
          <Detail label="Children" value={String(node.children.length)} />
        )}
      </div>
    </section>
  );
}

/** The selected note's heading outline (table of contents). */
function OutlineSection({ outline }: { outline: OutlineEntry[] }) {
  return (
    <section aria-label="Outline" className="utility-section">
      <h3 className="utility-section__heading">Outline</h3>
      {outline.length === 0 ? (
        <p className="utility-empty">No headings yet.</p>
      ) : (
        <ul className="outline" data-testid="note-outline">
          {outline.map((entry, index) => (
            <li
              key={`${index}-${entry.text}`}
              className="outline__item"
              data-level={entry.level}
            >
              {entry.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The selected note's links, from the whole-repo link graph: who links **to** it
 * (backlinks), what it links **to** (outbound), and any **broken** targets.
 * Resolved rows navigate; broken rows are flagged. Reflects committed content.
 */
function LinksSection({
  outbound,
  backlinks,
  broken,
  titleFor,
  onSelect,
}: {
  outbound: string[];
  backlinks: string[];
  broken: string[];
  titleFor: (path: string) => string;
  onSelect: (path: string) => void;
}) {
  const empty =
    outbound.length === 0 && backlinks.length === 0 && broken.length === 0;
  return (
    <section aria-label="Links" className="utility-section">
      <h3 className="utility-section__heading">Links</h3>
      {empty && <p className="utility-empty">No links to or from this note.</p>}
      {backlinks.length > 0 && (
        <>
          <p className="utility-subheading">Linked from</p>
          <ul className="links" data-testid="backlinks">
            {backlinks.map((path) => (
              <li key={`b-${path}`}>
                <button
                  type="button"
                  className="link-row"
                  data-testid="backlink"
                  data-path={path}
                  onClick={() => onSelect(path)}
                >
                  <span className="link-row__icon" aria-hidden="true">
                    ←
                  </span>
                  {titleFor(path)}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {outbound.length > 0 && (
        <>
          <p className="utility-subheading">Links to</p>
          <ul className="links" data-testid="outbound-links">
            {outbound.map((path) => (
              <li key={`o-${path}`}>
                <button
                  type="button"
                  className="link-row"
                  data-testid="outbound-link"
                  data-path={path}
                  onClick={() => onSelect(path)}
                >
                  <span className="link-row__icon" aria-hidden="true">
                    →
                  </span>
                  {titleFor(path)}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {broken.length > 0 && (
        <>
          <p className="utility-subheading">Broken</p>
          <ul className="links" data-testid="broken-links">
            {broken.map((target, index) => (
              <li
                key={`x-${index}-${target}`}
                className="link-row link-row--broken"
                data-testid="broken-link"
              >
                <span className="link-row__icon" aria-hidden="true">
                  ⚠
                </span>
                {target}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Walking-skeleton service health, kept in the utilities panel's footer. */
function HealthSection({ health }: { health: Fetched }) {
  return (
    <section aria-label="System" className="utility-section">
      <h3 className="utility-section__heading">System</h3>
      {health.state === "loading" && <p className="utility-empty">Checking health…</p>}
      {health.state === "error" && (
        <p role="alert" className="alert">
          Health check failed: {health.message}
        </p>
      )}
      {health.state === "ready" && (
        <dl className="health">
          <dt>Status</dt>
          <dd>
            <span
              className="health__dot"
              data-ok={health.health.status === "ok"}
              aria-hidden="true"
            />
            <span data-testid="status">{health.health.status}</span>
          </dd>
          <dt>Database</dt>
          <dd data-testid="database">
            {health.health.database ? "connected" : "unavailable"}
          </dd>
          <dt>Migration</dt>
          <dd data-testid="migration">{health.health.migration}</dd>
        </dl>
      )}
    </section>
  );
}

/**
 * The right contextual-utilities panel: everything about the **selected** note,
 * reusing data already loaded — its details (tree), heading outline (note body),
 * and links (link graph) — plus service health. Empty until a note is open.
 */
function UtilityPanel({
  selected,
  noteResult,
  treeResult,
  linkGraph,
  onSelect,
  health,
}: {
  selected: string | null;
  noteResult: NoteFetched;
  treeResult: TreeFetched;
  linkGraph: LinkGraph;
  onSelect: (path: string) => void;
  health: Fetched;
}) {
  const root = treeResult.state === "ready" ? treeResult.tree.root : null;
  const node = root !== null && selected !== null ? findNode(root, selected) : null;
  const titles = useMemo(
    () => (root !== null ? pathTitleMap(root) : new Map<string, string>()),
    [root],
  );
  const titleFor = useCallback(
    (path: string): string =>
      titles.get(path) ?? (path === "" ? "Home" : path),
    [titles],
  );

  const outline =
    noteResult.state === "ready" ? noteOutline(noteResult.note.markdown) : [];
  const outbound = linkGraph.edges
    .filter((edge) => edge.from === selected)
    .map((edge) => edge.to);
  const backlinks = linkGraph.edges
    .filter((edge) => edge.to === selected)
    .map((edge) => edge.from);
  const broken = linkGraph.broken
    .filter((link) => link.from === selected)
    .map((link) => link.target);

  return (
    <aside
      className="panel panel--utility"
      data-testid="utility-panel"
      aria-label="Note context"
    >
      <div className="utility__header">Context</div>
      <div className="panel__scroll">
        <div className="utility__body">
          {selected === null ? (
            <p className="utility-empty" data-testid="utility-empty">
              Open a note to see its context.
            </p>
          ) : (
            <>
              <DetailsSection node={node} selected={selected} />
              <OutlineSection outline={outline} />
              <LinksSection
                outbound={outbound}
                backlinks={backlinks}
                broken={broken}
                titleFor={titleFor}
                onSelect={onSelect}
              />
            </>
          )}
          <HealthSection health={health} />
        </div>
      </div>
    </aside>
  );
}

/** Which single panel is shown on a narrow (mobile) viewport. */
type MobilePane = "nav" | "editor" | "utility";

/**
 * The mobile pane switcher (hidden on desktop via CSS). On a narrow viewport the
 * workspace collapses to a single focused column; these tabs choose which panel —
 * navigation, editor, or context — is shown. Pure presentation state, identical
 * across runtimes.
 */
function MobileTabs({
  pane,
  onPane,
}: {
  pane: MobilePane;
  onPane: (pane: MobilePane) => void;
}) {
  const tabs: Array<[MobilePane, string]> = [
    ["nav", "Navigation"],
    ["editor", "Editor"],
    ["utility", "Context"],
  ];
  return (
    <nav className="mobile-tabs" aria-label="Workspace panels">
      {tabs.map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          className="mobile-tab"
          aria-selected={pane === id}
          onClick={() => onPane(id)}
        >
          {label}
        </button>
      ))}
    </nav>
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
  /**
   * Sink for conflict notifications. Called once on mount with a `notify` handle
   * the caller drives when a sync produces a conflict copy (see
   * {@link applyConflictResolution}); each call surfaces a non-blocking toast.
   * The server-backed web app leaves this unset (the server reconciles before
   * the client sees a conflict); the PWA offline runtime wires its sync
   * controller's conflict notifications into it. See ADR 0011.
   */
  onConflicts?: (notify: (notification: ConflictNotification) => void) => void;
  /**
   * The data source the whole UI reads and writes through: a `fetch`-shaped
   * seam. The server-backed web app and the Electron desktop leave this unset,
   * so it defaults to the global `fetch` and every hook/client talks to the live
   * `/api/*` HTTP surface unchanged. The **PWA offline runtime** injects an
   * in-browser adapter (`createBrowserApiFetch`) that routes the same `/api/*`
   * requests to the IndexedDB `BrowserGitEngine` — so there is one App, two
   * backends, and no UI fork. See ADR 0011.
   */
  fetchImpl?: typeof fetch;
}

export function App({
  Editor = TipTapEditor,
  debounceMs,
  onConflicts,
  fetchImpl = fetch,
}: AppProps = {}) {
  const health = useHealth(fetchImpl);
  const [selected, setSelected] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<MobilePane>("editor");
  // The note tree is fetched once here and shared by the nav (rendering), the
  // editor (wikilink resolution), and the utilities panel (details + link titles).
  // Bumping the token refetches the tree and link graph after a mutation.
  const [reloadToken, setReloadToken] = useState(0);
  const treeResult = useTree(fetchImpl, reloadToken);
  const noteResult = useNote(selected, fetchImpl);
  const linkGraph = useLinks(fetchImpl, reloadToken);
  const reloadTree = useCallback(() => setReloadToken((token) => token + 1), []);

  // Selecting a note also focuses the editor pane, so opening a note on mobile
  // (from the nav, a search hit, a wikilink, or a backlink) brings it into view.
  const selectNote = useCallback((path: string) => {
    setSelected(path);
    setMobilePane("editor");
  }, []);

  // Non-blocking conflict notifications. The toast list lives here so a conflict
  // copy created by a background sync surfaces over the whole workspace without
  // interrupting the editor. `notify` is handed to the (optional) conflict source
  // once; "Open copy" navigates to the saved sibling via the same `selectNote`.
  const conflicts = useConflictNotifications();
  const notifyConflict = conflicts.notify;
  useEffect(() => {
    onConflicts?.(notifyConflict);
  }, [onConflicts, notifyConflict]);

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
      onNavigate: (path) => selectNote(path),
    };
  }, [treeResult, selectNote]);

  return (
    <div className="app-shell" data-mobile-pane={mobilePane}>
      <div className="workspace">
        <NavPanel
          treeResult={treeResult}
          selectedPath={selected}
          onSelect={selectNote}
          onReload={reloadTree}
          debounceMs={debounceMs}
          fetchImpl={fetchImpl}
        />
        <main
          className="panel panel--editor"
          data-testid="editor-panel"
          aria-label="Editor"
        >
          <div className="panel__scroll">
            <NotePanel
              result={noteResult}
              Editor={Editor}
              debounceMs={debounceMs}
              wikiLinks={wikiLinks}
              fetchImpl={fetchImpl}
            />
          </div>
        </main>
        <UtilityPanel
          selected={selected}
          noteResult={noteResult}
          treeResult={treeResult}
          linkGraph={linkGraph}
          onSelect={selectNote}
          health={health}
        />
      </div>
      <MobileTabs pane={mobilePane} onPane={setMobilePane} />
      <ConflictToasts
        toasts={conflicts.toasts}
        onOpenCopy={selectNote}
        onDismiss={conflicts.dismiss}
      />
    </div>
  );
}
