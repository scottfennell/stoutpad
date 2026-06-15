import { describe, expect, it } from "vitest";
import {
  applyNoteSync,
  NoteSync,
  noteFileCandidates,
  wipBranchName,
  type SyncAction,
  type WipSyncEngine,
} from "./index.js";

/** A mutable virtual clock so debounce timing is fully deterministic. */
function createClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    set(value: number): void {
      t = value;
    },
    advance(by: number): void {
      t += by;
    },
  };
}

interface WipCommit {
  branch: string;
  notePath: string;
  markdown: string;
}
interface MainCommit {
  branch: string;
  file: string;
  message: string;
  markdown: string;
}

/**
 * In-memory {@link WipSyncEngine}: models a `main` working tree plus per-note wip
 * branches and a squash-into-main step.
 *
 * Mirrors the `InMemoryGitEngine` / `MigrationStore` pattern — an interface with
 * an in-memory double — so {@link NoteSync}'s wip lifecycle and squash triggers
 * are exercised without touching real Git. Every operation is appended to `ops`,
 * which the "never pushed" test inspects to prove no wip ref is ever pushed.
 */
class InMemoryWipEngine implements WipSyncEngine {
  /** Files committed on `main`. */
  readonly files = new Map<string, string>();
  /** Every wip commit, in order. */
  readonly wipCommits: WipCommit[] = [];
  /** Every squashed commit that landed on `main`, in order. */
  readonly mainCommits: MainCommit[] = [];
  /** Wip branches that currently exist. */
  readonly branches = new Set<string>();
  /** Ordered log of every engine operation (used to assert wip is never pushed). */
  readonly ops: string[] = [];

  constructor(seed: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(seed)) this.files.set(path, content);
  }

  wipBranchName(notePath: string): string {
    return wipBranchName(notePath);
  }

  async commitToWip(notePath: string, markdown: string): Promise<void> {
    const branch = wipBranchName(notePath);
    this.branches.add(branch);
    this.wipCommits.push({ branch, notePath, markdown });
    this.ops.push(`commitToWip ${branch}`);
  }

  async squashMergeWipToMain(notePath: string, message: string): Promise<void> {
    const branch = wipBranchName(notePath);
    const file = this.resolveFile(notePath);
    const last = [...this.wipCommits].reverse().find((c) => c.branch === branch);
    // A squash is a no-op when the wip branch holds no net change vs main.
    if (last && this.files.get(file) !== last.markdown) {
      this.files.set(file, last.markdown);
      this.mainCommits.push({ branch, file, message, markdown: last.markdown });
    }
    this.ops.push(`squashMergeWipToMain ${branch}`);
  }

  async deleteWip(notePath: string): Promise<void> {
    const branch = wipBranchName(notePath);
    this.branches.delete(branch);
    this.ops.push(`deleteWip ${branch}`);
  }

  private resolveFile(notePath: string): string {
    const candidates = noteFileCandidates(notePath);
    for (const file of candidates) if (this.files.has(file)) return file;
    return candidates[0];
  }
}

describe("wipBranchName", () => {
  it("derives wip/<note> from the note path", () => {
    expect(wipBranchName("notes")).toBe("wip/notes");
    expect(wipBranchName("projects/ideas")).toBe("wip/projects/ideas");
  });

  it("maps the root note to wip/root", () => {
    expect(wipBranchName("")).toBe("wip/root");
  });

  it("strips the .md extension and surrounding slashes", () => {
    expect(wipBranchName("/notes.md")).toBe("wip/notes");
  });

  it("sanitizes characters git forbids in a ref name", () => {
    expect(wipBranchName("my notes")).toBe("wip/my-notes");
    expect(wipBranchName("a..b")).toBe("wip/a-b");
    expect(wipBranchName("weird~^:?*[name")).toBe("wip/weird-name");
    // A path that sanitizes to nothing still yields a valid ref.
    expect(wipBranchName("~~~")).toBe("wip/root");
  });
});

describe("NoteSync — debounce → wip commit", () => {
  it("commits a buffered edit to the wip branch only after the debounce elapses", async () => {
    const engine = new InMemoryWipEngine({ "notes.md": "# Notes\n" });
    const clock = createClock(0);
    const sync = new NoteSync(engine, "notes", {
      clock,
      debounceMs: 3000,
      initialMarkdown: "# Notes\n",
    });

    sync.onEdit("# Notes\n\nHello\n");
    expect(sync.status.phase).toBe("pending");

    clock.set(2000);
    await sync.tick();
    expect(engine.wipCommits).toHaveLength(0); // still within the debounce window

    clock.set(3000);
    await sync.tick();
    expect(engine.wipCommits).toEqual([
      { branch: "wip/notes", notePath: "notes", markdown: "# Notes\n\nHello\n" },
    ]);
    expect(engine.mainCommits).toHaveLength(0); // not on main yet
    expect(engine.branches.has("wip/notes")).toBe(true);
    expect(sync.status).toMatchObject({ phase: "wip", wipCommits: 1 });
  });

  it("canonicalizes the edit before committing it to wip", async () => {
    const engine = new InMemoryWipEngine({ "notes.md": "# Notes\n" });
    const sync = new NoteSync(engine, "notes", { initialMarkdown: "# Notes\n" });

    sync.onEdit("#  Notes\n\n*  a\n+  b\n");
    await sync.flush();

    expect(engine.wipCommits[0].markdown).toBe("# Notes\n\n- a\n- b\n");
  });

  it("coalesces rapid keystrokes into a single wip commit (debounce)", async () => {
    const engine = new InMemoryWipEngine({ "notes.md": "# Notes\n" });
    const sync = new NoteSync(engine, "notes", { initialMarkdown: "# Notes\n" });

    sync.onEdit("# Notes\n\nx1\n");
    sync.onEdit("# Notes\n\nx2\n");
    sync.onEdit("# Notes\n\nx3\n");
    await sync.flush();

    expect(engine.wipCommits).toHaveLength(1);
    expect(engine.wipCommits[0].markdown).toBe("# Notes\n\nx3\n");
  });
});

describe("NoteSync — multiple edits → multiple wip commits", () => {
  it("makes one wip commit per debounce window", async () => {
    const engine = new InMemoryWipEngine({ "notes.md": "# Notes\n" });
    const clock = createClock(0);
    const sync = new NoteSync(engine, "notes", {
      clock,
      debounceMs: 3000,
      initialMarkdown: "# Notes\n",
    });

    sync.onEdit("# Notes\n\nA\n");
    clock.set(3000);
    await sync.tick();

    sync.onEdit("# Notes\n\nA\n\nB\n");
    clock.set(6000);
    await sync.tick();

    sync.onEdit("# Notes\n\nA\n\nB\n\nC\n");
    clock.set(9000);
    await sync.tick();

    expect(engine.wipCommits.map((c) => c.markdown)).toEqual([
      "# Notes\n\nA\n",
      "# Notes\n\nA\n\nB\n",
      "# Notes\n\nA\n\nB\n\nC\n",
    ]);
    expect(engine.mainCommits).toHaveLength(0); // still nothing on main
  });

  it("does not create an empty wip commit for a no-op edit", async () => {
    const engine = new InMemoryWipEngine({ "notes.md": "# Notes\n" });
    const sync = new NoteSync(engine, "notes", { initialMarkdown: "# Notes\n" });

    // Editing to the same canonical content as the note's current state.
    sync.onEdit("# Notes\n");
    await sync.flush();
    // ...and a formatting-only variant that canonicalizes identically.
    sync.onEdit("#  Notes\n");
    await sync.flush();

    expect(engine.wipCommits).toHaveLength(0);
    expect(sync.status.phase).toBe("idle");
  });
});

describe("NoteSync — focus-leave / idle / quit squash the session", () => {
  async function editingSession(trigger: "focus" | "idle" | "quit"): Promise<InMemoryWipEngine> {
    const engine = new InMemoryWipEngine({ "notes.md": "# Notes\n" });
    const sync = new NoteSync(engine, "notes", { initialMarkdown: "# Notes\n" });

    // Three wip commits across the session.
    sync.onEdit("# Notes\n\nA\n");
    await sync.flush();
    sync.onEdit("# Notes\n\nA\n\nB\n");
    await sync.flush();
    sync.onEdit("# Notes\n\nA\n\nB\n\nC\n");
    // Leave the last edit buffered to prove the pre-sync safety net flushes it.

    if (trigger === "focus") await sync.onFocusLeave();
    else if (trigger === "idle") await sync.onIdle();
    else await sync.onQuit();

    return engine;
  }

  it("squash-merges the wip branch into main as exactly one commit on focus-leave", async () => {
    const engine = await editingSession("focus");

    expect(engine.wipCommits).toHaveLength(3); // three wip commits during the session
    expect(engine.mainCommits).toHaveLength(1); // squashed to ONE commit on main
    expect(engine.mainCommits[0]).toMatchObject({
      file: "notes.md",
      message: "Edit notes",
      markdown: "# Notes\n\nA\n\nB\n\nC\n", // the final buffered edit was flushed first
    });
    expect(engine.files.get("notes.md")).toBe("# Notes\n\nA\n\nB\n\nC\n");
    expect(engine.branches.has("wip/notes")).toBe(false); // wip branch cleaned up
  });

  it("also squashes on idle and on quit (safety nets)", async () => {
    const idle = await editingSession("idle");
    expect(idle.mainCommits).toHaveLength(1);
    expect(idle.branches.size).toBe(0);

    const quit = await editingSession("quit");
    expect(quit.mainCommits).toHaveLength(1);
    expect(quit.branches.size).toBe(0);
  });

  it("uses a custom squash message when provided", async () => {
    const engine = new InMemoryWipEngine({ "notes.md": "# Notes\n" });
    const sync = new NoteSync(engine, "notes", { initialMarkdown: "# Notes\n" });

    sync.onEdit("# Notes\n\nEdited\n");
    await sync.flush();
    await sync.onFocusLeave("Custom session message");

    expect(engine.mainCommits[0].message).toBe("Custom session message");
  });

  it("defaults the root note's session message to 'Edit root note'", async () => {
    const engine = new InMemoryWipEngine({ "_index.md": "# Home\n" });
    const sync = new NoteSync(engine, "", { initialMarkdown: "# Home\n" });

    sync.onEdit("# Home\n\nWelcome\n");
    await sync.flush();
    await sync.onFocusLeave();

    expect(engine.mainCommits[0]).toMatchObject({
      file: "_index.md",
      message: "Edit root note",
    });
  });

  it("ending a session with no edits squashes nothing", async () => {
    const engine = new InMemoryWipEngine({ "notes.md": "# Notes\n" });
    const sync = new NoteSync(engine, "notes", { initialMarkdown: "# Notes\n" });

    await sync.onFocusLeave();

    expect(engine.wipCommits).toHaveLength(0);
    expect(engine.mainCommits).toHaveLength(0);
    expect(engine.ops.some((op) => op.startsWith("squashMergeWipToMain"))).toBe(false);
  });

  it("is idempotent: a second session-end does not squash again", async () => {
    const engine = new InMemoryWipEngine({ "notes.md": "# Notes\n" });
    const sync = new NoteSync(engine, "notes", { initialMarkdown: "# Notes\n" });

    sync.onEdit("# Notes\n\nZ\n");
    await sync.flush();
    await sync.onFocusLeave();
    await sync.onQuit(); // e.g. blur immediately followed by an unload

    expect(engine.mainCommits).toHaveLength(1);
    expect(engine.ops.filter((op) => op.startsWith("squashMergeWipToMain"))).toHaveLength(1);
  });
});

describe("NoteSync — one commit per editing session", () => {
  it("squashes each session into its own single main commit", async () => {
    const engine = new InMemoryWipEngine({ "notes.md": "# Notes\n" });
    const sync = new NoteSync(engine, "notes", { initialMarkdown: "# Notes\n" });

    // Session 1: several keystrokes (wip commits) → one main commit.
    for (const body of ["A", "A\n\nB", "A\n\nB\n\nC"]) {
      sync.onEdit(`# Notes\n\n${body}\n`);
      await sync.flush();
    }
    await sync.onFocusLeave();
    expect(engine.wipCommits.length).toBeGreaterThan(1);
    expect(engine.mainCommits).toHaveLength(1);

    // Session 2: a fresh edit after refocus → a second main commit.
    sync.onEdit("# Notes\n\nA\n\nB\n\nC\n\nD\n");
    await sync.flush();
    await sync.onQuit();

    expect(engine.mainCommits).toHaveLength(2);
    expect(engine.branches.size).toBe(0);
  });
});

describe("NoteSync — crash safety", () => {
  it("keeps in-progress autosave on the wip branch when a session never ends", async () => {
    const engine = new InMemoryWipEngine({ "notes.md": "# Notes\n" });
    const clock = createClock(0);
    const crashed = new NoteSync(engine, "notes", {
      clock,
      debounceMs: 3000,
      initialMarkdown: "# Notes\n",
    });

    crashed.onEdit("# Notes\n\nDraft\n");
    clock.set(3000);
    await crashed.tick(); // autosaved to wip...
    // ...then the app "crashes": no focus-leave, no squash.

    expect(engine.wipCommits).toHaveLength(1);
    expect(engine.branches.has("wip/notes")).toBe(true);
    expect(engine.mainCommits).toHaveLength(0);
    expect(engine.files.get("notes.md")).toBe("# Notes\n"); // main untouched
  });

  it("a fresh machine after reload continues the wip branch and later squashes it", async () => {
    const engine = new InMemoryWipEngine({ "notes.md": "# Notes\n" });
    const clock = createClock(0);

    const before = new NoteSync(engine, "notes", { clock, debounceMs: 3000 });
    before.onEdit("# Notes\n\nDraft\n");
    clock.set(3000);
    await before.tick();

    // Reload: a brand-new state machine for the same note + engine.
    const after = new NoteSync(engine, "notes", { clock, debounceMs: 3000 });
    after.onEdit("# Notes\n\nDraft\n\nMore\n");
    clock.set(6000);
    await after.tick();
    expect(engine.wipCommits).toHaveLength(2); // appended to the same wip branch

    await after.onFocusLeave();
    expect(engine.mainCommits).toHaveLength(1); // both wip commits squashed together
    expect(engine.files.get("notes.md")).toBe("# Notes\n\nDraft\n\nMore\n");
    expect(engine.branches.has("wip/notes")).toBe(false);
  });
});

describe("NoteSync — wip branches are never pushed", () => {
  it("performs no push during a full editing session", async () => {
    const engine = new InMemoryWipEngine({ "notes.md": "# Notes\n" });
    const sync = new NoteSync(engine, "notes", { initialMarkdown: "# Notes\n" });

    sync.onEdit("# Notes\n\nP\n");
    await sync.flush();
    await sync.onFocusLeave();

    // The wip seam exposes no push operation, so nothing the machine drives can
    // push a wip ref. Only commitToWip / squashMergeWipToMain / deleteWip ran.
    expect(engine.ops.some((op) => op.toLowerCase().includes("push"))).toBe(false);
    expect(engine.ops).toEqual([
      "commitToWip wip/notes",
      "squashMergeWipToMain wip/notes",
      "deleteWip wip/notes",
    ]);
  });
});

describe("applyNoteSync — server-side action dispatch", () => {
  it("autosave commits canonicalized Markdown to wip and echoes the branch", async () => {
    const engine = new InMemoryWipEngine({ "notes.md": "# Notes\n" });

    const result = await applyNoteSync(engine, {
      path: "notes",
      action: "autosave",
      markdown: "#  Notes\n\n*  Draft\n", // loose Markdown
    });

    expect(result).toEqual({
      path: "notes",
      action: "autosave",
      wipBranch: "wip/notes",
    });
    expect(engine.wipCommits[0].markdown).toBe("# Notes\n\n- Draft\n"); // canonicalized
  });

  it("squash defaults the message and folds the wip branch into main", async () => {
    const engine = new InMemoryWipEngine({ "notes.md": "# Notes\n" });
    await applyNoteSync(engine, { path: "notes", action: "autosave", markdown: "# Notes\n\nA\n" });

    await applyNoteSync(engine, { path: "notes", action: "squash" });

    expect(engine.mainCommits).toHaveLength(1);
    expect(engine.mainCommits[0].message).toBe("Edit notes"); // defaultSessionMessage
  });

  it("squash honors a provided commit message", async () => {
    const engine = new InMemoryWipEngine({ "notes.md": "# Notes\n" });
    await applyNoteSync(engine, { path: "notes", action: "autosave", markdown: "# Notes\n\nB\n" });

    await applyNoteSync(engine, { path: "notes", action: "squash", message: "Session edit" });

    expect(engine.mainCommits[0].message).toBe("Session edit");
  });

  it("delete-wip removes the note's wip branch", async () => {
    const engine = new InMemoryWipEngine({ "notes.md": "# Notes\n" });
    await applyNoteSync(engine, { path: "notes", action: "autosave", markdown: "# Notes\n\nC\n" });
    expect(engine.branches.has("wip/notes")).toBe(true);

    const result = await applyNoteSync(engine, { path: "notes", action: "delete-wip" });

    expect(result.action).toBe("delete-wip");
    expect(engine.branches.has("wip/notes")).toBe(false);
  });

  it("rejects an autosave with no Markdown", async () => {
    const engine = new InMemoryWipEngine();
    await expect(
      applyNoteSync(engine, { path: "notes", action: "autosave" }),
    ).rejects.toThrow(/markdown is required/u);
    expect(engine.wipCommits).toHaveLength(0);
  });

  it("rejects an unknown action", async () => {
    const engine = new InMemoryWipEngine();
    await expect(
      applyNoteSync(engine, { path: "notes", action: "publish" as SyncAction }),
    ).rejects.toThrow(/unknown sync action/u);
  });
});
