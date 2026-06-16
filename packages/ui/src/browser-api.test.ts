import { describe, expect, it } from "vitest";
import {
  NOTE_CREATE_PATH,
  NOTE_MOVE_PATH,
  NOTE_PATH,
  NOTE_RENAME_PATH,
  SYNC_PATH,
  type NoteContentResponse,
  type NoteSyncResponse,
  type NoteTreeResponse,
  type LinkGraphResponse,
  type SearchResponse,
  type HealthStatus,
  type NoteFile,
  type WritableGitEngine,
} from "@stout/core";
import { createBrowserApiFetch, createCommitOnSaveWipEngine } from "./browser-api.js";

/** A minimal in-memory {@link WritableGitEngine}, so the adapter is tested with no IndexedDB. */
class FakeEngine implements WritableGitEngine {
  readonly files = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(seed)) this.files.set(path, content);
  }

  async listNoteFiles(): Promise<NoteFile[]> {
    return [...this.files.keys()].sort().map((path) => ({ path }));
  }

  async readNoteFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async writeNoteFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
}

function seededEngine(): FakeEngine {
  return new FakeEngine({
    "_index.md": "# Home\n\nSee [[Notes]].\n",
    "notes.md": "# Notes\n\nA banana note about fruit.\n",
  });
}

describe("createBrowserApiFetch", () => {
  it("serves offline health (ok, no database)", async () => {
    const api = createBrowserApiFetch(seededEngine());
    const res = await api("/api/health");
    expect(res.ok).toBe(true);
    const health = (await res.json()) as HealthStatus;
    expect(health.status).toBe("ok");
    expect(health.service).toBe("stout");
    expect(health.database).toBe(false);
  });

  it("reads the note tree from the engine", async () => {
    const api = createBrowserApiFetch(seededEngine());
    const res = await api("/api/tree");
    const body = (await res.json()) as NoteTreeResponse;
    expect(body.root.path).toBe("");
    expect(body.root.children.map((c) => c.path)).toContain("notes");
  });

  it("reads a single note by identity, 404ing a missing one", async () => {
    const api = createBrowserApiFetch(seededEngine());

    const found = await api(`${NOTE_PATH}?path=notes`);
    expect(found.ok).toBe(true);
    const note = (await found.json()) as NoteContentResponse;
    expect(note.path).toBe("notes");
    expect(note.file).toBe("notes.md");
    expect(note.markdown).toContain("banana");

    const missing = await api(`${NOTE_PATH}?path=does/not/exist`);
    expect(missing.status).toBe(404);
  });

  it("writes a note edit through to the engine (canonicalized)", async () => {
    const engine = seededEngine();
    const api = createBrowserApiFetch(engine);
    const res = await api(NOTE_PATH, {
      method: "POST",
      body: JSON.stringify({ path: "notes", markdown: "# Notes\n\nUpdated body.\n" }),
    });
    expect(res.ok).toBe(true);
    const saved = (await res.json()) as NoteContentResponse;
    expect(saved.file).toBe("notes.md");
    expect(saved.markdown).toContain("Updated body.");
    expect(engine.files.get("notes.md")).toContain("Updated body.");
  });

  it("rejects a note save with no markdown (400)", async () => {
    const api = createBrowserApiFetch(seededEngine());
    const res = await api(NOTE_PATH, {
      method: "POST",
      body: JSON.stringify({ path: "notes" }),
    });
    expect(res.status).toBe(400);
  });

  it("autosaves a sync action straight to main and reports the wip ref", async () => {
    const engine = seededEngine();
    const api = createBrowserApiFetch(engine);
    const res = await api(SYNC_PATH, {
      method: "POST",
      body: JSON.stringify({ path: "notes", action: "autosave", markdown: "# Notes\n\nSynced.\n" }),
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as NoteSyncResponse;
    expect(body.action).toBe("autosave");
    expect(body.wipBranch).toBe("wip/notes");
    expect(engine.files.get("notes.md")).toContain("Synced.");
  });

  it("treats squash / delete-wip as no-op sync actions", async () => {
    const api = createBrowserApiFetch(seededEngine());
    for (const action of ["squash", "delete-wip"] as const) {
      const res = await api(SYNC_PATH, {
        method: "POST",
        body: JSON.stringify({ path: "notes", action }),
      });
      expect(res.ok).toBe(true);
      expect(((await res.json()) as NoteSyncResponse).action).toBe(action);
    }
  });

  it("builds the wikilink graph from the corpus", async () => {
    const api = createBrowserApiFetch(seededEngine());
    const res = await api("/api/links");
    const graph = (await res.json()) as LinkGraphResponse;
    expect(graph.edges).toContainEqual({ from: "", to: "notes" });
  });

  it("runs keyword search over the corpus", async () => {
    const api = createBrowserApiFetch(seededEngine());
    const res = await api("/api/search?q=banana");
    const body = (await res.json()) as SearchResponse;
    expect(body.mode).toBe("keyword");
    expect(body.results.map((r) => r.path)).toContain("notes");
  });

  it("returns an empty result set for a blank query", async () => {
    const api = createBrowserApiFetch(seededEngine());
    const res = await api("/api/search?q=");
    const body = (await res.json()) as SearchResponse;
    expect(body.results).toEqual([]);
  });

  it("answers mutations and attachments with a graceful 501", async () => {
    const api = createBrowserApiFetch(seededEngine());
    for (const path of [NOTE_CREATE_PATH, NOTE_RENAME_PATH, NOTE_MOVE_PATH, "/api/attachment"]) {
      const res = await api(path, { method: "POST", body: JSON.stringify({}) });
      expect(res.status).toBe(501);
      expect(((await res.json()) as { error: string }).error).toMatch(/not available offline/i);
    }
  });

  it("404s an unknown route", async () => {
    const api = createBrowserApiFetch(seededEngine());
    expect((await api("/api/nope")).status).toBe(404);
    expect((await api(NOTE_PATH, { method: "DELETE" })).status).toBe(404);
  });

  it("accepts a URL instance as the request input", async () => {
    const api = createBrowserApiFetch(seededEngine());
    const res = await api(new URL("http://offline.local/api/tree"));
    expect(res.ok).toBe(true);
  });
});

describe("createCommitOnSaveWipEngine", () => {
  it("commits an autosave to main and no-ops squash/delete", async () => {
    const engine = new FakeEngine({ "notes.md": "# Notes\n" });
    const wip = createCommitOnSaveWipEngine(engine);

    expect(wip.wipBranchName("notes")).toBe("wip/notes");
    await wip.commitToWip("notes", "# Notes\n\nEdited.\n");
    expect(engine.files.get("notes.md")).toContain("Edited.");

    await expect(wip.squashMergeWipToMain("notes", "msg")).resolves.toBeUndefined();
    await expect(wip.deleteWip("notes")).resolves.toBeUndefined();
  });
});
