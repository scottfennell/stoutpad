import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildTitleIndex,
  DEFAULT_DEBOUNCE_MS,
  HEALTH_PATH,
  NOTE_PATH,
  NoteSync,
  resolveTitle,
  TREE_PATH,
  type HealthStatus,
  type NoteContentResponse,
  type NoteNode,
  type NoteTreeResponse,
} from "@stout/core";
import { TipTapEditor } from "./TipTapEditor.js";
import { createHttpWipEngine } from "./sync-client.js";
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
  const ready = result.state === "ready";
  // Drive the autosave/squash session off the loaded note. Keyed on the note's
  // identity + its initial Markdown so switching notes ends the prior session.
  const onChange = useNoteSync(
    ready ? result.note.path : null,
    ready ? result.note.markdown : "",
    { debounceMs },
  );

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
        <article data-testid="note-content" data-note-path={result.note.path}>
          <Editor
            markdown={result.note.markdown}
            onChange={onChange}
            wikiLinks={wikiLinks}
          />
        </article>
      )}
    </section>
  );
}

export interface AppProps {
  /** Swappable editor seam; defaults to the TipTap implementation. */
  Editor?: EditorComponent;
  /**
   * Idle debounce (ms) before a buffered edit is autosaved to the note's wip
   * branch. Defaults to {@link DEFAULT_DEBOUNCE_MS}; tests pass a small value for
   * determinism.
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
