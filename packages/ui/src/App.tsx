import { useEffect, useState } from "react";
import { HEALTH_PATH, type HealthStatus } from "@stout/core";

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

export function App() {
  const result = useHealth();

  return (
    <main style={{ fontFamily: "ui-monospace, monospace", padding: "2rem" }}>
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
  );
}
