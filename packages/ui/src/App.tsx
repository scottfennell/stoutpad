import { useCallback, useEffect, useRef, useState } from "react";
import {
  HEALTH_PATH,
  NOTE_PATH,
  TREE_PATH,
  type HealthStatus,
  type NoteContentResponse,
  type NoteNode,
  type NoteSaveRequest,
  type NoteTreeResponse,
} from "@stout/core";
import { TipTapEditor } from "./TipTapEditor.js";
import type { EditorComponent } from "./editor.js";

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

export function useTree(fetchImpl: typeof fetch = fetch): TreeFetched {
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
  }, [fetchImpl]);

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
 * Persist a note's edited Markdown via `POST /api/note`. The server canonicalizes
 * and commits it; the response carries the canonical Markdown the editor adopts.
 */
export async function postNote(
  path: string,
  markdown: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NoteContentResponse> {
  const res = await fetchImpl(NOTE_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, markdown } satisfies NoteSaveRequest),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as NoteContentResponse;
}

/**
 * A debounced note saver: coalesces rapid edits into a single `POST /api/note`
 * once the user pauses for `delayMs`. This is the minimal "save on edit" wiring
 * for this slice; richer autosave/squash semantics land in #6.
 */
export function useDebouncedSave(
  delayMs = 600,
  fetchImpl: typeof fetch = fetch,
): (path: string, markdown: string) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return useCallback(
    (path: string, markdown: string) => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        // Best-effort for this slice; surfacing save errors is part of #6.
        void postNote(path, markdown, fetchImpl).catch(() => undefined);
      }, delayMs);
    },
    [delayMs, fetchImpl],
  );
}

function NoteTreeItem({
  node,
  selectedPath,
  onSelect,
}: {
  node: NoteNode;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const isSelected = selectedPath === node.path;
  return (
    <li>
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
          padding: "0.15rem 0.35rem",
          textAlign: "left",
          width: "100%",
        }}
      >
        {node.title}
      </button>
      {node.children.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, paddingLeft: "1rem" }}>
          {node.children.map((child) => (
            <NoteTreeItem
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function NavPanel({
  selectedPath,
  onSelect,
}: {
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const result = useTree();

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
      {result.state === "loading" && <p>Loading notes…</p>}
      {result.state === "error" && (
        <p role="alert">Could not load notes: {result.message}</p>
      )}
      {result.state === "ready" && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          <NoteTreeItem
            node={result.tree.root}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        </ul>
      )}
    </nav>
  );
}

function NotePanel({
  selectedPath,
  Editor,
  saveDelayMs,
}: {
  selectedPath: string | null;
  Editor: EditorComponent;
  saveDelayMs?: number;
}) {
  const result = useNote(selectedPath);
  const save = useDebouncedSave(saveDelayMs);

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
            onChange={(markdown) => save(result.note.path, markdown)}
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
   * Debounce (ms) before an edit is persisted via `POST /api/note`. Defaults to
   * the {@link useDebouncedSave} default; tests pass a small value for determinism.
   */
  saveDelayMs?: number;
}

export function App({ Editor = TipTapEditor, saveDelayMs }: AppProps = {}) {
  const result = useHealth();
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        fontFamily: "ui-monospace, monospace",
      }}
    >
      <NavPanel selectedPath={selected} onSelect={setSelected} />
      <main style={{ flex: 1, padding: "2rem" }}>
        <h1>Stout</h1>
        <NotePanel
          selectedPath={selected}
          Editor={Editor}
          saveDelayMs={saveDelayMs}
        />
        <section>
          <h2>Service health</h2>
          {result.state === "loading" && <p>Checking health…</p>}
          {result.state === "error" && (
            <p role="alert">Health check failed: {result.message}</p>
          )}
          {result.state === "ready" && (
            <dl>
              <dt>Status</dt>
              <dd data-testid="status">{result.health.status}</dd>
              <dt>Database</dt>
              <dd data-testid="database">
                {result.health.database ? "connected" : "unavailable"}
              </dd>
              <dt>Migration</dt>
              <dd data-testid="migration">{result.health.migration}</dd>
            </dl>
          )}
        </section>
      </main>
    </div>
  );
}
