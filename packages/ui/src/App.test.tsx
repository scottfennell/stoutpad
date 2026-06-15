import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { App } from "./App.js";
import type { HealthStatus } from "@stout/core";

describe("App", () => {
  it("renders the health result returned by the server", async () => {
    const health: HealthStatus = {
      status: "ok",
      service: "stout",
      database: true,
      migration: 1,
      timestamp: new Date().toISOString(),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(health), { status: 200 })),
    );

    render(<App />);

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("ok"),
    );
    expect(screen.getByTestId("database").textContent).toBe("connected");
    expect(screen.getByTestId("migration").textContent).toBe("1");
  });
});
