import { useEffect, useState } from "react";
import {
  HEALTH_PATH,
  TREE_PATH,
  type HealthStatus,
  type NoteNode,
  type NoteTreeResponse,
} from "@stout/core";

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

function NoteTreeItem({ node }: { node: NoteNode }) {
  return (
    <li>
      <span data-testid="note-title">{node.title}</span>
      {node.children.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, paddingLeft: "1rem" }}>
          {node.children.map((child) => (
            <NoteTreeItem key={child.path} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

function NavPanel() {
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
          <NoteTreeItem node={result.tree.root} />
        </ul>
      )}
    </nav>
  );
}

export function App() {
  const result = useHealth();

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        fontFamily: "ui-monospace, monospace",
      }}
    >
      <NavPanel />
      <main style={{ flex: 1, padding: "2rem" }}>
        <h1>Stout</h1>
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
