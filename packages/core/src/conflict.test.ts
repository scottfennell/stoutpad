import { describe, expect, it } from "vitest";
import {
  applyConflictResolution,
  canonicalizeMarkdown,
  conflictCopyTitle,
  formatConflictMarker,
  mergeNoteContent,
  planConflictCopy,
  resolveNoteConflict,
  type NoteFile,
  type WritableGitEngine,
} from "./index.js";

/**
 * In-memory {@link WritableGitEngine}: a `main` working tree as a path→content map
 * plus a commit log. Mirrors the `InMemoryWipEngine` pattern so the conflict
 * policy's writes are exercised without touching real Git.
 */
class InMemoryWritableEngine implements WritableGitEngine {
  readonly files = new Map<string, string>();
  readonly commits: Array<{ file: string; message: string }> = [];

  constructor(seed: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(seed)) this.files.set(path, content);
  }

  async listNoteFiles(): Promise<NoteFile[]> {
    return [...this.files.keys()].sort().map((path) => ({ path }));
  }

  async readNoteFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async writeNoteFile(path: string, content: string, message: string): Promise<void> {
    if (this.files.get(path) === content) return; // skip no-op (no empty commit)
    this.files.set(path, content);
    this.commits.push({ file: path, message });
  }
}

const BASE = ["# Title", "", "Line A", "", "Line B", "", "Line C", ""].join("\n");

/** Replace one line of {@link BASE}, returning canonical Markdown. */
function edit(line: string, replacement: string): string {
  return canonicalizeMarkdown(BASE.replace(line, replacement));
}

describe("mergeNoteContent", () => {
  it("is a clean no-op when both sides are identical", () => {
    const result = mergeNoteContent({ base: BASE, local: BASE, incoming: BASE });
    expect(result).toEqual({ status: "clean", markdown: canonicalizeMarkdown(BASE), merged: false });
  });

  it("fast-forwards to incoming when only the other device changed", () => {
    const incoming = edit("Line C", "Line C remote");
    const result = mergeNoteContent({ base: BASE, local: BASE, incoming });
    expect(result).toEqual({ status: "clean", markdown: incoming, merged: false });
  });

  it("keeps local when only this device changed", () => {
    const local = edit("Line A", "Line A mine");
    const result = mergeNoteContent({ base: BASE, local, incoming: BASE });
    expect(result).toEqual({ status: "clean", markdown: local, merged: false });
  });

  it("auto-merges non-overlapping concurrent edits (combining both sides)", () => {
    const local = edit("Line A", "Line A local");
    const incoming = edit("Line C", "Line C incoming");
    const result = mergeNoteContent({ base: BASE, local, incoming });

    expect(result.status).toBe("clean");
    if (result.status !== "clean") throw new Error("expected clean");
    expect(result.merged).toBe(true);
    // Both edits survive in the single merged result.
    expect(result.markdown).toContain("Line A local");
    expect(result.markdown).toContain("Line C incoming");
    expect(result.markdown).toBe(
      canonicalizeMarkdown(
        ["# Title", "", "Line A local", "", "Line B", "", "Line C incoming", ""].join("\n"),
      ),
    );
  });

  it("reports a true conflict when both sides change the same region differently", () => {
    const local = edit("Line B", "Line B local");
    const incoming = edit("Line B", "Line B incoming");
    const result = mergeNoteContent({ base: BASE, local, incoming });

    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") throw new Error("expected conflict");
    expect(result.local).toBe(local);
    expect(result.incoming).toBe(incoming);
  });

  it("treats an identical edit on both sides as clean (not a conflict)", () => {
    const same = edit("Line B", "Line B agreed");
    const result = mergeNoteContent({ base: BASE, local: same, incoming: same });
    expect(result).toEqual({ status: "clean", markdown: same, merged: false });
  });
});

describe("formatConflictMarker", () => {
  it("formats a Date as a sortable UTC YYYYMMDD-HHmmss marker", () => {
    expect(formatConflictMarker(new Date(Date.UTC(2026, 5, 16, 13, 5, 9)))).toBe(
      "20260616-130509",
    );
  });
});

describe("conflictCopyTitle", () => {
  it("appends a parenthetical conflict-copy suffix to the title", () => {
    expect(conflictCopyTitle("Meeting Notes", "20260616-130509")).toBe(
      "Meeting Notes (conflict copy 20260616-130509)",
    );
  });
});

describe("planConflictCopy", () => {
  it("plans a sibling leaf note that preserves the local body verbatim", () => {
    const local = "# Meeting\n\nMy local notes\n";
    const copy = planConflictCopy("meeting", "Meeting", local, "20260616-130509");

    expect(copy.path).toBe("meeting-conflict-copy-20260616-130509");
    expect(copy.file).toBe("meeting-conflict-copy-20260616-130509.md");
    expect(copy.title).toBe("Meeting (conflict copy 20260616-130509)");
    // Body is preserved (zero data loss); the copy title is set in frontmatter.
    expect(copy.markdown).toContain("My local notes");
    expect(copy.markdown).toContain("Meeting (conflict copy 20260616-130509)");
  });

  it("places the copy beside a nested note (same parent)", () => {
    const copy = planConflictCopy("projects/ideas", "Ideas", "# Ideas\n", "M");
    expect(copy.path).toBe("projects/ideas-conflict-copy-m");
    expect(copy.file).toBe("projects/ideas-conflict-copy-m.md");
  });

  it("suffixes to avoid colliding with an existing note", () => {
    const taken = ["meeting-conflict-copy-m"];
    const copy = planConflictCopy("meeting", "Meeting", "# Meeting\n", "M", taken);
    expect(copy.path).toBe("meeting-conflict-copy-m-2");
  });
});

describe("resolveNoteConflict", () => {
  it("resolves a non-overlapping merge to a clean write (no copy, no notification)", () => {
    const resolution = resolveNoteConflict({
      notePath: "notes/log",
      base: BASE,
      local: edit("Line A", "Line A local"),
      incoming: edit("Line C", "Line C incoming"),
      marker: "M",
    });

    expect(resolution.status).toBe("clean");
    if (resolution.status !== "clean") throw new Error("expected clean");
    expect(resolution.merged).toBe(true);
    expect(resolution.markdown).toContain("Line A local");
    expect(resolution.markdown).toContain("Line C incoming");
  });

  it("keeps incoming on the note and plans a conflict copy + notification on a true conflict", () => {
    const local = edit("Line B", "Line B local");
    const incoming = edit("Line B", "Line B incoming");
    const resolution = resolveNoteConflict({
      notePath: "notes/log",
      title: "Daily Log",
      base: BASE,
      local,
      incoming,
      marker: "20260616-130509",
    });

    expect(resolution.status).toBe("conflict");
    if (resolution.status !== "conflict") throw new Error("expected conflict");
    // The note keeps the incoming main version...
    expect(resolution.markdown).toBe(incoming);
    // ...and the local version is preserved as a sibling copy.
    expect(resolution.copy.path).toBe("notes/daily-log-conflict-copy-20260616-130509");
    expect(resolution.copy.markdown).toContain("Line B local");
    expect(resolution.notification).toEqual({
      notePath: "notes/log",
      noteTitle: "Daily Log",
      copyPath: "notes/daily-log-conflict-copy-20260616-130509",
      copyTitle: "Daily Log (conflict copy 20260616-130509)",
      message:
        '"Daily Log" had a conflicting edit — your version was saved as "Daily Log (conflict copy 20260616-130509)".',
    });
  });
});

describe("applyConflictResolution", () => {
  it("writes the merged content to the note on a clean resolution", async () => {
    const engine = new InMemoryWritableEngine({ "log.md": canonicalizeMarkdown(BASE) });
    const resolution = resolveNoteConflict({
      notePath: "log",
      base: BASE,
      local: edit("Line A", "Line A local"),
      incoming: edit("Line C", "Line C incoming"),
      marker: "M",
    });

    const result = await applyConflictResolution(engine, resolution);

    expect(result).toEqual({ notePath: "log", status: "clean" });
    expect(engine.files.get("log.md")).toContain("Line A local");
    expect(engine.files.get("log.md")).toContain("Line C incoming");
  });

  it("keeps both versions on a true conflict (incoming on note, local in copy)", async () => {
    const engine = new InMemoryWritableEngine({ "log.md": canonicalizeMarkdown(BASE) });
    const local = edit("Line B", "Line B local");
    const incoming = edit("Line B", "Line B incoming");
    const resolution = resolveNoteConflict({
      notePath: "log",
      title: "Log",
      base: BASE,
      local,
      incoming,
      marker: "M",
    });

    const result = await applyConflictResolution(engine, resolution);

    // The note now holds the incoming main version.
    expect(engine.files.get("log.md")).toBe(incoming);
    // The local version is preserved verbatim in the sibling conflict copy.
    const copy = engine.files.get("log-conflict-copy-m.md");
    expect(copy).toBeDefined();
    expect(copy).toContain("Line B local");
    // The user is notified of the copy.
    expect(result.status).toBe("conflict");
    expect(result.notification?.copyPath).toBe("log-conflict-copy-m");
  });
});
