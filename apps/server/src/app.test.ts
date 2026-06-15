import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  HEALTH_PATH,
  NOTE_PATH,
  SYNC_PATH,
  TREE_PATH,
  type HealthStatus,
  type NoteContentResponse,
  type NoteSyncRequest,
  type NoteTreeResponse,
} from "@stout/core";
import { createApp } from "./app.js";

const okHealth: HealthStatus = {
  status: "ok",
  service: "stout",
  database: true,
  migration: 1,
  timestamp: new Date().toISOString(),
};

const sampleTree: NoteTreeResponse = {
  root: {
    path: "",
    title: "Home",
    file: "_index.md",
    kind: "parent",
    children: [
      { path: "notes", title: "Notes", file: "notes.md", kind: "leaf", children: [] },
    ],
  },
};

describe("health round-trip", () => {
  it("returns the health status as JSON with 200", async () => {
    const app = createApp({ getHealth: async () => okHealth });

    const res = await request(app).get(HEALTH_PATH);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      service: "stout",
      database: true,
      migration: 1,
    });
  });

  it("returns 503 when the service is degraded", async () => {
    const app = createApp({
      getHealth: async () => ({ ...okHealth, status: "degraded", database: false }),
    });

    const res = await request(app).get(HEALTH_PATH);

    expect(res.status).toBe(503);
    expect(res.body.database).toBe(false);
  });

  it("returns 503 when the health check throws", async () => {
    const app = createApp({
      getHealth: async () => {
        throw new Error("db down");
      },
    });

    const res = await request(app).get(HEALTH_PATH);

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
  });
});

describe("tree round-trip", () => {
  it("returns the note tree as JSON", async () => {
    const app = createApp({ getHealth: async () => okHealth, getTree: async () => sampleTree });

    const res = await request(app).get(TREE_PATH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(sampleTree);
    expect(res.body.root.children[0].title).toBe("Notes");
  });

  it("returns 500 when reading the tree fails", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      getTree: async () => {
        throw new Error("repo unreadable");
      },
    });

    const res = await request(app).get(TREE_PATH);

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("repo unreadable");
  });

  it("does not mount the tree endpoint when no reader is injected", async () => {
    const app = createApp({ getHealth: async () => okHealth });

    const res = await request(app).get(TREE_PATH);

    expect(res.status).toBe(404);
  });
});

describe("note round-trip", () => {
  const sampleNote: NoteContentResponse = {
    path: "notes",
    file: "notes.md",
    markdown: "# Notes\n\n- [x] Done\n- [ ] Todo\n",
  };

  it("returns a note's content by identity", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      getNote: async (path) => (path === "notes" ? sampleNote : null),
    });

    const res = await request(app).get(NOTE_PATH).query({ path: "notes" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(sampleNote);
  });

  it("treats a missing path query as the root note", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      getNote: async (path) => ({ path, file: "_index.md", markdown: "# Home\n" }),
    });

    const res = await request(app).get(NOTE_PATH);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ path: "", file: "_index.md" });
  });

  it("returns 404 when the note is missing", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      getNote: async () => null,
    });

    const res = await request(app).get(NOTE_PATH).query({ path: "ghost" });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("ghost");
  });

  it("returns 500 when reading the note fails", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      getNote: async () => {
        throw new Error("repo unreadable");
      },
    });

    const res = await request(app).get(NOTE_PATH).query({ path: "notes" });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("repo unreadable");
  });

  it("does not mount the note endpoint when no reader is injected", async () => {
    const app = createApp({ getHealth: async () => okHealth });

    const res = await request(app).get(NOTE_PATH).query({ path: "notes" });

    expect(res.status).toBe(404);
  });
});

describe("note save round-trip", () => {
  it("saves an edited note and returns the canonical response", async () => {
    const saved: NoteContentResponse = {
      path: "notes",
      file: "notes.md",
      markdown: "# Notes\n\n- a\n- b\n",
    };
    const calls: Array<{ path: string; markdown: string }> = [];
    const app = createApp({
      getHealth: async () => okHealth,
      saveNote: async (path, markdown) => {
        calls.push({ path, markdown });
        return saved;
      },
    });

    const res = await request(app)
      .post(NOTE_PATH)
      .send({ path: "notes", markdown: "#  Notes\n\n*  a\n+  b\n" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(saved);
    // The raw edit reaches the saver verbatim (canonicalization is its job).
    expect(calls).toEqual([
      { path: "notes", markdown: "#  Notes\n\n*  a\n+  b\n" },
    ]);
  });

  it("treats a missing path as the root note", async () => {
    let savedPath: string | undefined;
    const app = createApp({
      getHealth: async () => okHealth,
      saveNote: async (path, markdown) => {
        savedPath = path;
        return { path, file: "_index.md", markdown };
      },
    });

    const res = await request(app).post(NOTE_PATH).send({ markdown: "# Home\n" });

    expect(res.status).toBe(200);
    expect(savedPath).toBe("");
  });

  it("returns 400 when the markdown body is missing", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      saveNote: async () => {
        throw new Error("must not be called");
      },
    });

    const res = await request(app).post(NOTE_PATH).send({ path: "notes" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("markdown");
  });

  it("returns 500 when saving fails", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      saveNote: async () => {
        throw new Error("disk full");
      },
    });

    const res = await request(app)
      .post(NOTE_PATH)
      .send({ path: "notes", markdown: "# x\n" });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("disk full");
  });

  it("does not mount the save endpoint when no saver is injected", async () => {
    const app = createApp({ getHealth: async () => okHealth });

    const res = await request(app)
      .post(NOTE_PATH)
      .send({ path: "notes", markdown: "# x\n" });

    expect(res.status).toBe(404);
  });
});

describe("note sync round-trip", () => {
  /** A recording `syncNote` that echoes back a response. */
  function recordingApp() {
    const calls: NoteSyncRequest[] = [];
    const app = createApp({
      getHealth: async () => okHealth,
      syncNote: async (request) => {
        calls.push(request);
        return {
          path: request.path,
          action: request.action,
          wipBranch: `wip/${request.path === "" ? "root" : request.path}`,
        };
      },
    });
    return { app, calls };
  }

  it("dispatches an autosave to the wip branch", async () => {
    const { app, calls } = recordingApp();

    const res = await request(app)
      .post(SYNC_PATH)
      .send({ path: "notes", action: "autosave", markdown: "# Notes\n\nDraft\n" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      path: "notes",
      action: "autosave",
      wipBranch: "wip/notes",
    });
    // The raw edit reaches the engine verbatim (canonicalization is its job).
    expect(calls).toEqual([
      { path: "notes", action: "autosave", markdown: "# Notes\n\nDraft\n", message: undefined },
    ]);
  });

  it("dispatches squash and delete-wip actions", async () => {
    const { app, calls } = recordingApp();

    const squash = await request(app)
      .post(SYNC_PATH)
      .send({ path: "notes", action: "squash", message: "Edit notes" });
    const remove = await request(app)
      .post(SYNC_PATH)
      .send({ path: "notes", action: "delete-wip" });

    expect(squash.status).toBe(200);
    expect(remove.status).toBe(200);
    expect(calls.map((c) => c.action)).toEqual(["squash", "delete-wip"]);
    expect(calls[0].message).toBe("Edit notes");
  });

  it("treats a missing path as the root note", async () => {
    const { app, calls } = recordingApp();

    const res = await request(app)
      .post(SYNC_PATH)
      .send({ action: "autosave", markdown: "# Home\n" });

    expect(res.status).toBe(200);
    expect(res.body.wipBranch).toBe("wip/root");
    expect(calls[0].path).toBe("");
  });

  it("returns 400 for a missing or unknown action", async () => {
    const { app } = recordingApp();

    const missing = await request(app).post(SYNC_PATH).send({ path: "notes" });
    const unknown = await request(app)
      .post(SYNC_PATH)
      .send({ path: "notes", action: "push" });

    expect(missing.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain("action");
  });

  it("returns 400 when an autosave is missing markdown", async () => {
    const { app, calls } = recordingApp();

    const res = await request(app)
      .post(SYNC_PATH)
      .send({ path: "notes", action: "autosave" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("markdown");
    expect(calls).toHaveLength(0); // never reaches the engine
  });

  it("returns 500 when the sync action fails", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      syncNote: async () => {
        throw new Error("git exploded");
      },
    });

    const res = await request(app)
      .post(SYNC_PATH)
      .send({ path: "notes", action: "delete-wip" });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("git exploded");
  });

  it("does not mount the sync endpoint when no syncNote is injected", async () => {
    const app = createApp({ getHealth: async () => okHealth });

    const res = await request(app)
      .post(SYNC_PATH)
      .send({ path: "notes", action: "delete-wip" });

    expect(res.status).toBe(404);
  });
});
