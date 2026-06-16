import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from "@testing-library/react";
import { App } from "./App.js";
import type { EditorComponent } from "./editor.js";
import {
  ATTACHMENT_PATH,
  HEALTH_PATH,
  LINKS_PATH,
  NOTE_CREATE_PATH,
  NOTE_MOVE_PATH,
  NOTE_PATH,
  NOTE_RENAME_PATH,
  SEARCH_PATH,
  SYNC_PATH,
  TREE_PATH,
  type ConflictNotification,
  type HealthStatus,
  type LinkGraphResponse,
  type NoteContentResponse,
  type NoteSyncResponse,
  type NoteTreeResponse,
  type SearchResponse,
} from "@stout/core";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

/**
 * An Editor seam that surfaces the injected wikilink context: the autocomplete
 * titles, a sample resolution, and a button that navigates a `[[link]]` target —
 * so the App's tree → resolver → navigate wiring is testable without TipTap.
 */
const WikiLinkProbe: EditorComponent = ({ wikiLinks }) => (
  <div>
    <span data-testid="wikilink-titles">{(wikiLinks?.titles ?? []).join(",")}</span>
    <span data-testid="wikilink-resolve">
      {wikiLinks?.resolve("Projects") ?? "broken"}
    </span>
    <span data-testid="wikilink-resolve-missing">
      {wikiLinks?.resolve("Nope") ?? "broken"}
    </span>
    <button
      type="button"
      data-testid="wikilink-nav"
      onClick={() =>
        wikiLinks?.onNavigate?.(wikiLinks.resolve("Projects") ?? "", "Projects")
      }
    >
      go to projects
    </button>
  </div>
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

/**
 * Stub `fetch` with per-route status + body control, so a rejected mutation can
 * return a 400 `{ error }`. Routes are keyed by URL (the mutation paths are all
 * distinct), defaulting to status 200.
 */
function stubRoutes(
  routes: Record<string, { status?: number; body: unknown }>,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const route = routes[url];
      if (route === undefined) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
    }),
  );
}

/** Parsed bodies of every POST to `url`, in order. */
function postBodies(url: string): Array<Record<string, unknown>> {
  return vi
    .mocked(fetch)
    .mock.calls.filter(
      ([u, init]) => u === url && (init as RequestInit | undefined)?.method === "POST",
    )
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

/** Count of GET requests to `url` (a tree reload bumps this). */
function getCount(url: string): number {
  return vi
    .mocked(fetch)
    .mock.calls.filter(
      ([u, init]) =>
        u === url && (init as RequestInit | undefined)?.method !== "POST",
    ).length;
}

describe("App note mutations", () => {
  it("creates a child note under a parent and reselects it", async () => {
    vi.stubGlobal("prompt", vi.fn(() => "Tasks"));
    const created: NoteContentResponse = {
      path: "projects/tasks",
      file: "projects/tasks.md",
      markdown: "# Tasks\n",
    };
    stubRoutes({
      [HEALTH_PATH]: { body: health },
      [TREE_PATH]: { body: tree },
      [NOTE_CREATE_PATH]: { body: { path: "projects/tasks", file: "projects/tasks.md" } },
      [`${NOTE_PATH}?path=projects%2Ftasks`]: { body: created },
    });

    render(<App Editor={FakeEditor} />);

    fireEvent.click(await screen.findByRole("button", { name: "New note under Projects" }));

    // The create endpoint receives the parent identity + the prompted name...
    await waitFor(() =>
      expect(postBodies(NOTE_CREATE_PATH)).toEqual([
        { parent: "projects", name: "Tasks" },
      ]),
    );
    // ...and the new note is auto-selected (loaded into the center panel).
    await waitFor(() =>
      expect(
        screen.getByTestId("note-content").getAttribute("data-note-path"),
      ).toBe("projects/tasks"),
    );
  });

  it("reloads the tree after a successful mutation", async () => {
    vi.stubGlobal("prompt", vi.fn(() => "Tasks"));
    stubRoutes({
      [HEALTH_PATH]: { body: health },
      [TREE_PATH]: { body: tree },
      [NOTE_CREATE_PATH]: { body: { path: "tasks", file: "tasks.md" } },
      [`${NOTE_PATH}?path=tasks`]: {
        body: { path: "tasks", file: "tasks.md", markdown: "# Tasks\n" },
      },
    });

    render(<App Editor={FakeEditor} />);
    await screen.findByRole("button", { name: "Home" });
    expect(getCount(TREE_PATH)).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "New note under Home" }));

    // The tree is refetched once the mutation lands, so the new note appears.
    await waitFor(() => expect(getCount(TREE_PATH)).toBe(2));
  });

  it("renames a note in place", async () => {
    vi.stubGlobal("prompt", vi.fn(() => "Renamed"));
    stubRoutes({
      [HEALTH_PATH]: { body: health },
      [TREE_PATH]: { body: tree },
      [NOTE_RENAME_PATH]: { body: { path: "renamed", file: "renamed.md" } },
      [`${NOTE_PATH}?path=renamed`]: {
        body: { path: "renamed", file: "renamed.md", markdown: "# Renamed\n" },
      },
    });

    render(<App Editor={FakeEditor} />);

    fireEvent.click(await screen.findByRole("button", { name: "Rename Notes" }));

    await waitFor(() =>
      expect(postBodies(NOTE_RENAME_PATH)).toEqual([
        { path: "notes", name: "Renamed" },
      ]),
    );
  });

  it("moves a note under the parent named in the prompt", async () => {
    vi.stubGlobal("prompt", vi.fn(() => "projects"));
    stubRoutes({
      [HEALTH_PATH]: { body: health },
      [TREE_PATH]: { body: tree },
      [NOTE_MOVE_PATH]: { body: { path: "projects/notes", file: "projects/notes.md" } },
      [`${NOTE_PATH}?path=projects%2Fnotes`]: {
        body: { path: "projects/notes", file: "projects/notes.md", markdown: "# Notes\n" },
      },
    });

    render(<App Editor={FakeEditor} />);

    fireEvent.click(await screen.findByRole("button", { name: "Move Notes" }));

    await waitFor(() =>
      expect(postBodies(NOTE_MOVE_PATH)).toEqual([
        { path: "notes", parent: "projects" },
      ]),
    );
  });

  it("does not call the API when the create prompt is cancelled", async () => {
    vi.stubGlobal("prompt", vi.fn(() => null));
    stubRoutes({
      [HEALTH_PATH]: { body: health },
      [TREE_PATH]: { body: tree },
      [NOTE_CREATE_PATH]: { body: { path: "x", file: "x.md" } },
    });

    render(<App Editor={FakeEditor} />);

    fireEvent.click(await screen.findByRole("button", { name: "New note under Home" }));

    // Give any (unexpected) request a tick to fire, then assert none did.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(postBodies(NOTE_CREATE_PATH)).toEqual([]);
  });

  it("shows the server's error message when a mutation is rejected", async () => {
    vi.stubGlobal("prompt", vi.fn(() => "Ideas"));
    stubRoutes({
      [HEALTH_PATH]: { body: health },
      [TREE_PATH]: { body: tree },
      [NOTE_CREATE_PATH]: {
        status: 400,
        body: { error: "a note already exists at projects/ideas" },
      },
    });

    render(<App Editor={FakeEditor} />);

    fireEvent.click(await screen.findByRole("button", { name: "New note under Projects" }));

    expect(
      await screen.findByText(/a note already exists at projects\/ideas/),
    ).toBeTruthy();
    // A rejected create never reshapes the tree, so no reload happens.
    expect(getCount(TREE_PATH)).toBe(1);
  });
});

describe("App wikilinks", () => {
  it("resolves [[link]] targets against the loaded tree by title", async () => {
    const note: NoteContentResponse = {
      path: "notes",
      file: "notes.md",
      markdown: "See [[Projects]]\n",
    };
    stubApi({
      [HEALTH_PATH]: health,
      [TREE_PATH]: tree,
      [`${NOTE_PATH}?path=notes`]: note,
    });

    render(<App Editor={WikiLinkProbe} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));

    // Every note title is offered for `[[` autocomplete, in tree order...
    await waitFor(() =>
      expect(screen.getByTestId("wikilink-titles").textContent).toBe(
        "Home,Projects,Ideas,Notes",
      ),
    );
    // ...a real title resolves to its note identity, an unknown one is broken.
    expect(screen.getByTestId("wikilink-resolve").textContent).toBe("projects");
    expect(screen.getByTestId("wikilink-resolve-missing").textContent).toBe("broken");
  });

  it("opens the linked note when a resolved wikilink is followed", async () => {
    const notes: NoteContentResponse = {
      path: "notes",
      file: "notes.md",
      markdown: "See [[Projects]]\n",
    };
    const projects: NoteContentResponse = {
      path: "projects",
      file: "projects/_index.md",
      markdown: "# Projects\n",
    };
    stubApi({
      [HEALTH_PATH]: health,
      [TREE_PATH]: tree,
      [`${NOTE_PATH}?path=notes`]: notes,
      [`${NOTE_PATH}?path=projects`]: projects,
    });

    render(<App Editor={WikiLinkProbe} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    await waitFor(() =>
      expect(
        screen.getByTestId("note-content").getAttribute("data-note-path"),
      ).toBe("notes"),
    );

    // Following the link navigates the center panel to the resolved note...
    fireEvent.click(screen.getByTestId("wikilink-nav"));
    await waitFor(() =>
      expect(
        screen.getByTestId("note-content").getAttribute("data-note-path"),
      ).toBe("projects"),
    );
    // ...without refetching the tree (resolution is client-side).
    expect(getCount(TREE_PATH)).toBe(1);
  });
});

describe("App frontmatter & attachments", () => {
  it("renders the note title and tags as a header from its frontmatter", async () => {
    const note: NoteContentResponse = {
      path: "notes",
      file: "notes.md",
      markdown:
        "---\ntitle: My Great Note\ntags: [architecture, draft]\n---\n\n# Body\n\nText.\n",
    };
    stubApi({
      [HEALTH_PATH]: health,
      [TREE_PATH]: tree,
      [`${NOTE_PATH}?path=notes`]: note,
    });

    render(<App Editor={FakeEditor} />);
    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));

    // The frontmatter title heads the panel and the tags render as chips...
    await waitFor(() =>
      expect(screen.getByTestId("note-title-heading").textContent).toBe(
        "My Great Note",
      ),
    );
    expect(screen.getAllByTestId("note-tag").map((el) => el.textContent)).toEqual([
      "#architecture",
      "#draft",
    ]);
    // ...while the editor only ever sees the frontmatter-free Markdown body.
    const editorText = screen.getByTestId("fake-editor").textContent ?? "";
    expect(editorText).toContain("# Body");
    expect(editorText).not.toContain("title:");
    expect(editorText).not.toContain("---");
  });

  it("falls back to a derived title and shows no chips without frontmatter", async () => {
    const note: NoteContentResponse = {
      path: "notes",
      file: "notes.md",
      markdown: "# Notes\n",
    };
    stubApi({
      [HEALTH_PATH]: health,
      [TREE_PATH]: tree,
      [`${NOTE_PATH}?path=notes`]: note,
    });

    render(<App Editor={FakeEditor} />);
    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));

    await waitFor(() =>
      expect(screen.getByTestId("note-title-heading").textContent).toBe("Notes"),
    );
    expect(screen.queryByTestId("note-tags")).toBeNull();
  });

  it("uploads an image attachment and embeds it in the note body", async () => {
    const note: NoteContentResponse = {
      path: "notes",
      file: "notes.md",
      markdown: "# Notes\n",
    };
    stubApi({
      [HEALTH_PATH]: health,
      [TREE_PATH]: tree,
      [`${NOTE_PATH}?path=notes`]: note,
      [ATTACHMENT_PATH]: { path: "assets/diagram.png" },
      [SYNC_PATH]: { path: "notes", action: "autosave", wipBranch: "wip/notes" },
    });

    render(<App Editor={FakeEditor} debounceMs={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));

    const input = await screen.findByTestId("attachment-input");
    const file = new File(["binary"], "Diagram.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    // The returned stored path is embedded as an image in the (frontmatter-free)
    // body the editor renders.
    await waitFor(() =>
      expect(screen.getByTestId("fake-editor").textContent).toContain(
        "![Diagram](assets/diagram.png)",
      ),
    );
    // The upload posted the file name and its base64-encoded bytes.
    const uploadBody = postBodies(ATTACHMENT_PATH)[0];
    expect(uploadBody.name).toBe("Diagram.png");
    expect(typeof uploadBody.dataBase64).toBe("string");
  });

  it("surfaces the server's error when an attachment upload is rejected", async () => {
    const note: NoteContentResponse = {
      path: "notes",
      file: "notes.md",
      markdown: "# Notes\n",
    };
    stubRoutes({
      [HEALTH_PATH]: { body: health },
      [TREE_PATH]: { body: tree },
      [`${NOTE_PATH}?path=notes`]: { body: note },
      [ATTACHMENT_PATH]: { status: 500, body: { error: "disk full" } },
    });

    render(<App Editor={FakeEditor} />);
    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));

    const input = await screen.findByTestId("attachment-input");
    fireEvent.change(input, {
      target: { files: [new File(["x"], "x.png", { type: "image/png" })] },
    });

    expect(await screen.findByText("disk full")).toBeTruthy();
  });
});

/** Fetch calls (any method) whose URL targets the search endpoint, in order. */
function searchCalls(): string[] {
  return vi
    .mocked(fetch)
    .mock.calls.map(([input]) =>
      typeof input === "string" ? input : (input as URL).toString(),
    )
    .filter((url) => url.startsWith(SEARCH_PATH));
}

describe("App search", () => {
  const searchResponse: SearchResponse = {
    query: "notes",
    mode: "semantic",
    results: [
      { path: "notes", title: "Notes", snippet: "my notes about things", score: 0.91 },
    ],
  };

  it("only queries the index after non-empty input", async () => {
    stubApi({
      [HEALTH_PATH]: health,
      [TREE_PATH]: tree,
      [`${SEARCH_PATH}?q=notes`]: searchResponse,
    });

    render(<App Editor={FakeEditor} debounceMs={0} />);

    // The box renders, but an empty query never touches the search endpoint.
    const input = await screen.findByTestId("search-input");
    expect(searchCalls()).toEqual([]);

    fireEvent.change(input, { target: { value: "notes" } });

    // Once there is a query, the (debounced) search fires exactly one request,
    // carrying the typed query in the `q` param.
    await waitFor(() => expect(searchCalls()).toEqual([`${SEARCH_PATH}?q=notes`]));
    // The ranking mode the server actually used is surfaced to the user.
    expect(screen.getByTestId("search-mode").textContent).toBe("semantic");
  });

  it("clears back to no request when the query is emptied", async () => {
    stubApi({
      [HEALTH_PATH]: health,
      [TREE_PATH]: tree,
      [`${SEARCH_PATH}?q=notes`]: searchResponse,
    });

    render(<App Editor={FakeEditor} debounceMs={0} />);

    const input = await screen.findByTestId("search-input");
    fireEvent.change(input, { target: { value: "notes" } });
    await waitFor(() => expect(searchCalls().length).toBe(1));

    // Emptying the box returns to idle without firing another search request.
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(screen.queryByTestId("search-results")).toBeNull());
    expect(searchCalls().length).toBe(1);
  });

  it("opens a clicked result in the center panel", async () => {
    const note: NoteContentResponse = {
      path: "notes",
      file: "notes.md",
      markdown: "# Notes\n",
    };
    stubApi({
      [HEALTH_PATH]: health,
      [TREE_PATH]: tree,
      [`${SEARCH_PATH}?q=notes`]: searchResponse,
      [`${NOTE_PATH}?path=notes`]: note,
    });

    render(<App Editor={FakeEditor} debounceMs={0} />);

    fireEvent.change(await screen.findByTestId("search-input"), {
      target: { value: "notes" },
    });

    // Clicking a ranked hit selects that note, loading it into the center panel.
    fireEvent.click(await screen.findByTestId("search-result"));
    await waitFor(() =>
      expect(
        screen.getByTestId("note-content").getAttribute("data-note-path"),
      ).toBe("notes"),
    );
  });
});

describe("App workspace layout", () => {
  it("renders the three workspace panels and the mobile pane switcher", async () => {
    stubApi({ [HEALTH_PATH]: health, [TREE_PATH]: tree });

    render(<App Editor={FakeEditor} />);

    // The three regions are always in the DOM; the responsive stylesheet (loaded
    // only by the app entry, never in tests) governs which is visible on a narrow
    // viewport, so there is no per-runtime layout fork to test.
    expect(await screen.findByTestId("nav-panel")).toBeTruthy();
    expect(screen.getByTestId("editor-panel")).toBeTruthy();
    expect(screen.getByTestId("utility-panel")).toBeTruthy();

    // Each panel is a named landmark for assistive tech.
    expect(screen.getByRole("main", { name: "Editor" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Navigation" })).toBeTruthy();
    expect(
      screen.getByRole("complementary", { name: "Note context" }),
    ).toBeTruthy();

    // The single-column switcher offers exactly the three panes. They are tabs,
    // not buttons, so they never collide with same-named tree / nav buttons.
    expect(screen.getAllByRole("tab").map((el) => el.textContent)).toEqual([
      "Navigation",
      "Editor",
      "Context",
    ]);
  });

  it("keeps the context panel empty until a note is selected", async () => {
    stubApi({ [HEALTH_PATH]: health, [TREE_PATH]: tree });

    render(<App Editor={FakeEditor} />);

    // The utilities panel is contextual to the open note — empty until one is.
    expect(await screen.findByTestId("utility-empty")).toBeTruthy();
  });
});

describe("App utility panel", () => {
  const note: NoteContentResponse = {
    path: "notes",
    file: "notes.md",
    markdown: "# Notes\n\n## Section A\n\n### Subsection\n",
  };
  const projects: NoteContentResponse = {
    path: "projects",
    file: "projects/_index.md",
    markdown: "# Projects\n",
  };
  // Projects → Notes (a backlink into the open note), Notes → Ideas (outbound),
  // and Notes → [[Ghost Note]] (a broken link).
  const links: LinkGraphResponse = {
    edges: [
      { from: "projects", to: "notes" },
      { from: "notes", to: "projects/ideas" },
    ],
    broken: [{ from: "notes", target: "Ghost Note" }],
  };

  it("shows the selected note's details and heading outline", async () => {
    stubApi({
      [HEALTH_PATH]: health,
      [TREE_PATH]: tree,
      [LINKS_PATH]: links,
      [`${NOTE_PATH}?path=notes`]: note,
    });

    render(<App Editor={FakeEditor} />);
    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    await waitFor(() =>
      expect(
        screen.getByTestId("note-content").getAttribute("data-note-path"),
      ).toBe("notes"),
    );

    // Details reflect the note's tree node: identity, backing file, and kind.
    const details = screen
      .getAllByTestId("utility-detail")
      .map((el) => el.textContent ?? "");
    expect(details).toEqual(
      expect.arrayContaining([
        expect.stringContaining("notes"),
        expect.stringContaining("notes.md"),
        expect.stringContaining("leaf"),
      ]),
    );

    // The outline flattens the note body's headings, in document order.
    const outline = [
      ...screen.getByTestId("note-outline").querySelectorAll("li"),
    ].map((li) => li.textContent);
    expect(outline).toEqual(["Notes", "Section A", "Subsection"]);
  });

  it("lists backlinks, outbound and broken links, and navigates on click", async () => {
    stubApi({
      [HEALTH_PATH]: health,
      [TREE_PATH]: tree,
      [LINKS_PATH]: links,
      [`${NOTE_PATH}?path=notes`]: note,
      [`${NOTE_PATH}?path=projects`]: projects,
    });

    render(<App Editor={FakeEditor} />);
    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));

    // Backlinks: who links *to* this note (Projects), shown by title.
    await waitFor(() =>
      expect(
        screen.getAllByTestId("backlink").map((el) => el.textContent),
      ).toEqual([expect.stringContaining("Projects")]),
    );
    // Outbound: what this note links *to* (Ideas), by title.
    expect(
      screen.getAllByTestId("outbound-link").map((el) => el.textContent),
    ).toEqual([expect.stringContaining("Ideas")]);
    // Broken: the unresolved target title, as written.
    expect(
      screen.getAllByTestId("broken-link").map((el) => el.textContent),
    ).toEqual([expect.stringContaining("Ghost Note")]);

    // Following a backlink opens that note in the center panel — the same
    // navigation the tree, search hits, and wikilinks use.
    fireEvent.click(screen.getByTestId("backlink"));
    await waitFor(() =>
      expect(
        screen.getByTestId("note-content").getAttribute("data-note-path"),
      ).toBe("projects"),
    );
  });
});

describe("App conflict notifications", () => {
  const notification: ConflictNotification = {
    notePath: "notes",
    noteTitle: "Notes",
    copyPath: "notes (conflict 20240101-000000)",
    copyTitle: "Notes (conflict 20240101-000000)",
    message: "Conflicting edits to Notes were saved as a copy.",
  };

  it("surfaces a conflict copy as a non-blocking toast and opens the copy", async () => {
    const copy: NoteContentResponse = {
      path: notification.copyPath,
      file: `${notification.copyPath}.md`,
      markdown: "# Notes (conflict 20240101-000000)\n",
    };
    stubApi({
      [HEALTH_PATH]: health,
      [TREE_PATH]: tree,
      [`${NOTE_PATH}?path=${encodeURIComponent(copy.path)}`]: copy,
    });

    // The conflict sink is handed a `notify` handle on mount; the PWA sync
    // runtime would drive it, here the test does.
    let notify: ((n: ConflictNotification) => void) | null = null;
    render(<App Editor={FakeEditor} onConflicts={(fn) => (notify = fn)} />);
    await waitFor(() => expect(notify).not.toBeNull());

    // Nothing is shown until a conflict actually happens — quiet by default.
    expect(screen.queryByTestId("conflict-toasts")).toBeNull();

    act(() => notify!(notification));

    // The toast lands in a polite live region (never a modal), stating what
    // happened, with the editor still fully interactive behind it.
    const toasts = await screen.findByTestId("conflict-toasts");
    expect(toasts.getAttribute("role")).toBe("status");
    expect(toasts.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByTestId("conflict-toast").textContent).toContain(
      "saved as a copy",
    );

    // "Open copy" navigates the center panel to the saved sibling note — the
    // same navigation the tree and wikilinks use, so the user never loses work.
    fireEvent.click(screen.getByTestId("conflict-open-copy"));
    await waitFor(() =>
      expect(
        screen.getByTestId("note-content").getAttribute("data-note-path"),
      ).toBe(copy.path),
    );
  });

  it("dismisses a conflict toast on request", async () => {
    stubApi({ [HEALTH_PATH]: health, [TREE_PATH]: tree });

    let notify: ((n: ConflictNotification) => void) | null = null;
    render(<App Editor={FakeEditor} onConflicts={(fn) => (notify = fn)} />);
    await waitFor(() => expect(notify).not.toBeNull());

    act(() => notify!(notification));
    expect(await screen.findByTestId("conflict-toast")).toBeTruthy();

    // Dismissal removes the toast entirely; the workspace was never blocked.
    fireEvent.click(screen.getByTestId("conflict-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("conflict-toast")).toBeNull());
  });
});
