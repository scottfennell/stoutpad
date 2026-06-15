import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { App } from "./App.js";
import type { EditorComponent } from "./editor.js";
import {
  HEALTH_PATH,
  NOTE_PATH,
  SYNC_PATH,
  TREE_PATH,
  type HealthStatus,
  type NoteContentResponse,
  type NoteSyncResponse,
  type NoteTreeResponse,
} from "@stout/core";

afterEach(cleanup);

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

/** A trivial Editor seam implementation that just shows the Markdown it gets. */
const FakeEditor: EditorComponent = ({ markdown }) => (
  <pre data-testid="fake-editor">{markdown}</pre>
);

/** An Editor seam that emits an edit (through the seam) when its button is clicked. */
const EditableFake: EditorComponent = ({ markdown, onChange }) => (
  <button
    type="button"
    data-testid="editor-edit"
    onClick={() => onChange?.(`${markdown}edited\n`)}
  >
    edit
  </button>
);

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

    render(<App Editor={FakeEditor} />);

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

  it("opens a note in the center panel when its tree item is clicked", async () => {
    const note: NoteContentResponse = {
      path: "notes",
      file: "notes.md",
      markdown: "# Notes\n\n- [x] Done\n- [ ] Todo\n",
    };
    stubApi({
      [HEALTH_PATH]: health,
      [TREE_PATH]: tree,
      [`${NOTE_PATH}?path=notes`]: note,
    });

    render(<App Editor={FakeEditor} />);

    // Nothing is open until a note is selected.
    expect(await screen.findByTestId("note-empty")).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));

    await waitFor(() =>
      expect(screen.getByTestId("fake-editor").textContent).toContain("# Notes"),
    );
    expect(screen.getByTestId("note-content").getAttribute("data-note-path")).toBe(
      "notes",
    );
  });

  it("autosaves edits to the note's wip branch via POST /api/note/sync", async () => {
    const note: NoteContentResponse = {
      path: "notes",
      file: "notes.md",
      markdown: "# Notes\n",
    };
    const syncResponse: NoteSyncResponse = {
      path: "notes",
      action: "autosave",
      wipBranch: "wip/notes",
    };
    stubApi({
      [HEALTH_PATH]: health,
      [TREE_PATH]: tree,
      [`${NOTE_PATH}?path=notes`]: note,
      // Every wip-branch action posts to the bare sync path (no query string).
      [SYNC_PATH]: syncResponse,
    });

    render(<App Editor={EditableFake} debounceMs={0} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    // Editing through the seam fires onChange → debounced autosave to wip.
    fireEvent.click(await screen.findByTestId("editor-edit"));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        SYNC_PATH,
        expect.objectContaining({ method: "POST" }),
      ),
    );

    // The autosave posts the note identity, the autosave action, and the edited
    // Markdown — never the old `POST /api/note` commit-on-save path.
    const body = syncBodies()[0];
    expect(body.action).toBe("autosave");
    expect(body.path).toBe("notes");
    expect(body.markdown).toContain("edited");
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(
          ([url, init]) =>
            url === NOTE_PATH && (init as RequestInit | undefined)?.method === "POST",
        ),
    ).toBe(false);
  });

  it("squash-merges the session into main when the window blurs", async () => {
    const note: NoteContentResponse = {
      path: "notes",
      file: "notes.md",
      markdown: "# Notes\n",
    };
    stubApi({
      [HEALTH_PATH]: health,
      [TREE_PATH]: tree,
      [`${NOTE_PATH}?path=notes`]: note,
      [SYNC_PATH]: { path: "notes", action: "autosave", wipBranch: "wip/notes" },
    });

    render(<App Editor={EditableFake} debounceMs={50} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    // Buffer an edit, then blur before the debounce fires: focus-leave flushes
    // the pending edit to wip, then squashes the wip branch into main.
    fireEvent.click(await screen.findByTestId("editor-edit"));
    window.dispatchEvent(new Event("blur"));

    await waitFor(() =>
      expect(syncBodies().map((b) => b.action)).toEqual(
        expect.arrayContaining(["autosave", "squash", "delete-wip"]),
      ),
    );
  });
});

/** Parsed bodies of every `POST /api/note/sync` call, in order. */
function syncBodies(): Array<{ path: string; action: string; markdown?: string }> {
  return vi
    .mocked(fetch)
    .mock.calls.filter(
      ([url, init]) =>
        url === SYNC_PATH && (init as RequestInit | undefined)?.method === "POST",
    )
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}
