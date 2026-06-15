import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { App } from "./App.js";
import {
  HEALTH_PATH,
  TREE_PATH,
  type HealthStatus,
  type NoteTreeResponse,
} from "@stout/core";

const health: HealthStatus = {
  status: "ok",
  service: "stout",
  database: true,
  migration: 1,
  timestamp: new Date().toISOString(),
};

const tree: NoteTreeResponse = {
  root: {
    path: "",
    title: "Home",
    file: "_index.md",
    kind: "parent",
    children: [
      {
        path: "projects",
        title: "Projects",
        file: "projects/_index.md",
        kind: "parent",
        children: [
          {
            path: "projects/ideas",
            title: "Ideas",
            file: "projects/ideas.md",
            kind: "leaf",
            children: [],
          },
        ],
      },
      { path: "notes", title: "Notes", file: "notes.md", kind: "leaf", children: [] },
    ],
  },
};

/** Stub `fetch` so each endpoint returns its own payload. */
function stubApi(payloads: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = payloads[url];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

describe("App", () => {
  it("renders the health result returned by the server", async () => {
    stubApi({ [HEALTH_PATH]: health, [TREE_PATH]: tree });

    render(<App />);

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("ok"),
    );
    expect(screen.getByTestId("database").textContent).toBe("connected");
    expect(screen.getByTestId("migration").textContent).toBe("1");
  });

  it("renders the note hierarchy in the left navigation panel", async () => {
    stubApi({ [HEALTH_PATH]: health, [TREE_PATH]: tree });

    render(<App />);

    await waitFor(() =>
      expect(screen.getAllByTestId("note-title").length).toBeGreaterThan(0),
    );
    const titles = screen
      .getAllByTestId("note-title")
      .map((el) => el.textContent);
    // Root, nested parent, nested leaf, and a top-level leaf are all rendered.
    expect(titles).toEqual(
      expect.arrayContaining(["Home", "Projects", "Ideas", "Notes"]),
    );
  });
});
