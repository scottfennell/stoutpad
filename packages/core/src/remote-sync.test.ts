import { describe, expect, it } from "vitest";
import {
  canonicalizeMarkdown,
  InMemoryTokenStore,
  reconcileNotesWithIncoming,
  syncRemoteBoundary,
  type BoundaryFetch,
  type BoundaryNote,
  type NoteFile,
  type RemoteBoundaryEngine,
} from "./index.js";

const BASE = ["# Daily Log", "", "Line A", "", "Line B", "", "Line C", ""].join("\n");

/** Replace one line of {@link BASE}, returning canonical Markdown. */
function edit(line: string, replacement: string): string {
  return canonicalizeMarkdown(BASE.replace(line, replacement));
}

describe("reconcileNotesWithIncoming", () => {
  it("auto-merges a non-overlapping external edit (clean, both sides survive)", () => {
    const notes: BoundaryNote[] = [
      {
        notePath: "notes/log",
        base: BASE,
        local: edit("Line A", "Line A local"),
        incoming: edit("Line C", "Line C remote"),
      },
    ];

    const { resolutions, notifications } = reconcileNotesWithIncoming(notes, { marker: "M" });

    expect(notifications).toEqual([]);
    expect(resolutions).toHaveLength(1);
    const [resolution] = resolutions;
    expect(resolution.status).toBe("clean");
    if (resolution.status !== "clean") throw new Error("expected clean");
    expect(resolution.markdown).toContain("Line A local");
    expect(resolution.markdown).toContain("Line C remote");
  });

  it("keeps both versions on a true conflict (incoming on note, local as copy)", () => {
    const notes: BoundaryNote[] = [
      {
        notePath: "notes/log",
        title: "Daily Log",
        base: BASE,
        local: edit("Line B", "Line B local"),
        incoming: edit("Line B", "Line B remote"),
      },
    ];

    const { resolutions, notifications } = reconcileNotesWithIncoming(notes, { marker: "M" });

    expect(resolutions).toHaveLength(1);
    const [resolution] = resolutions;
    expect(resolution.status).toBe("conflict");
    if (resolution.status !== "conflict") throw new Error("expected conflict");
    expect(resolution.markdown).toContain("Line B remote"); // note keeps incoming
    expect(resolution.copy.markdown).toContain("Line B local"); // local preserved
    expect(notifications).toEqual([resolution.notification]);
  });

  it("adopts an external-only note (clean)", () => {
    const notes: BoundaryNote[] = [
      { notePath: "notes/new", base: null, local: null, incoming: "# New\n\nFrom the remote\n" },
    ];

    const { resolutions } = reconcileNotesWithIncoming(notes, { marker: "M" });

    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toMatchObject({ status: "clean", notePath: "notes/new" });
  });

  it("does not propagate an external deletion (incoming absent → keep local)", () => {
    const notes: BoundaryNote[] = [
      { notePath: "notes/log", base: BASE, local: edit("Line A", "Line A local"), incoming: null },
    ];

    expect(reconcileNotesWithIncoming(notes, { marker: "M" })).toEqual({
      resolutions: [],
      notifications: [],
    });
  });

  it("skips a note already in sync", () => {
    const same = edit("Line A", "Line A agreed");
    const notes: BoundaryNote[] = [{ notePath: "notes/log", base: BASE, local: same, incoming: same }];

    expect(reconcileNotesWithIncoming(notes, { marker: "M" })).toEqual({
      resolutions: [],
      notifications: [],
    });
  });
});

/**
 * In-memory {@link RemoteBoundaryEngine}: a local `main` working tree (path →
 * content) plus the content the external `ref` and merge `base` hold, so the
 * orchestrator runs end-to-end without touching real Git.
 */
class FakeBoundaryEngine implements RemoteBoundaryEngine {
  readonly commits: Array<{ file: string; message: string }> = [];
  recordedMerge: { ref: string; message: string } | null = null;
  pushed: { url: string; branch: string } | null = null;

  constructor(
    private readonly fetched: BoundaryFetch | null,
    private readonly local: Map<string, string>,
    private readonly incoming: Map<string, string>,
    private readonly base: Map<string, string>,
  ) {}

  async listNoteFiles(): Promise<NoteFile[]> {
    return [...this.local.keys()].sort().map((path) => ({ path }));
  }

  async readNoteFile(path: string): Promise<string | null> {
    return this.local.get(path) ?? null;
  }

  async writeNoteFile(path: string, content: string, message: string): Promise<void> {
    if (this.local.get(path) === content) return;
    this.local.set(path, content);
    this.commits.push({ file: path, message });
  }

  async fetchBoundary(): Promise<BoundaryFetch | null> {
    return this.fetched;
  }

  async changedNoteFiles(): Promise<string[]> {
    const files = new Set<string>([...this.local.keys(), ...this.incoming.keys()]);
    return [...files].filter((f) => {
      const local = this.local.get(f);
      const incoming = this.incoming.get(f);
      return canonicalizeMarkdownOrNull(local) !== canonicalizeMarkdownOrNull(incoming);
    });
  }

  async readFileAt(ref: string, file: string): Promise<string | null> {
    const map = ref === "BASE" ? this.base : this.incoming;
    return map.get(file) ?? null;
  }

  async recordBoundaryMerge(ref: string, message: string): Promise<void> {
    this.recordedMerge = { ref, message };
  }

  async pushBoundary(url: string, branch: string): Promise<void> {
    this.pushed = { url, branch };
  }

  /** The current local `main` content for a backing file (for assertions). */
  fileContent(path: string): string | undefined {
    return this.local.get(path);
  }
}

function canonicalizeMarkdownOrNull(markdown: string | undefined): string | null {
  return markdown === undefined ? null : canonicalizeMarkdown(markdown);
}

const FETCH: BoundaryFetch = { ref: "REMOTE", baseRef: "BASE" };

describe("syncRemoteBoundary", () => {
  it("seeds an empty remote by pushing (publish)", async () => {
    const engine = new FakeBoundaryEngine(null, new Map([["_index.md", "# Home\n"]]), new Map(), new Map());

    const result = await syncRemoteBoundary(
      engine,
      new InMemoryTokenStore(null),
      { remoteUrl: "/tmp/external.git" },
    );

    expect(result.action).toBe("publish");
    expect(engine.pushed).toEqual({ url: "/tmp/external.git", branch: "main" });
    expect(engine.recordedMerge).toBeNull();
  });

  it("auto-merges a non-overlapping external edit and pushes", async () => {
    const engine = new FakeBoundaryEngine(
      FETCH,
      new Map([["notes/log.md", edit("Line A", "Line A local")]]),
      new Map([["notes/log.md", edit("Line C", "Line C remote")]]),
      new Map([["notes/log.md", canonicalizeMarkdown(BASE)]]),
    );

    const result = await syncRemoteBoundary(
      engine,
      new InMemoryTokenStore(null),
      { remoteUrl: "/tmp/external.git" },
      { marker: "M" },
    );

    expect(result.action).toBe("sync");
    expect(result.conflicts).toEqual([]);
    expect(result.merged).toContain("notes/log");
    // Both edits survive on the note (zero data loss)…
    expect(engine.fileContent("notes/log.md")).toContain("Line A local");
    expect(engine.fileContent("notes/log.md")).toContain("Line C remote");
    // …and the merge was recorded before the push so the push is a fast-forward.
    expect(engine.recordedMerge?.ref).toBe("REMOTE");
    expect(engine.pushed).toEqual({ url: "/tmp/external.git", branch: "main" });
  });

  it("keeps both versions on a conflicting external edit and notifies", async () => {
    const engine = new FakeBoundaryEngine(
      FETCH,
      new Map([["notes/log.md", edit("Line B", "Line B local")]]),
      new Map([["notes/log.md", edit("Line B", "Line B remote")]]),
      new Map([["notes/log.md", canonicalizeMarkdown(BASE)]]),
    );

    const result = await syncRemoteBoundary(
      engine,
      new InMemoryTokenStore(null),
      { remoteUrl: "/tmp/external.git" },
      { marker: "M" },
    );

    expect(result.conflicts).toHaveLength(1);
    // The note keeps the incoming (external) version…
    expect(engine.fileContent("notes/log.md")).toContain("Line B remote");
    // …and the local version is preserved in a sibling conflict copy.
    const copy = engine.fileContent("notes/log-conflict-copy-m.md");
    expect(copy).toBeDefined();
    expect(copy).toContain("Line B local");
    expect(engine.pushed).not.toBeNull();
  });
});
