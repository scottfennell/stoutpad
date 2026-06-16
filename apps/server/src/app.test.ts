import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import {
  ATTACHMENT_PATH,
  HEALTH_PATH,
  LINKS_PATH,
  NOTE_CREATE_PATH,
  NOTE_MOVE_PATH,
  NOTE_PATH,
  NOTE_RENAME_PATH,
  NoteMutationError,
  SYNC_PATH,
  TREE_PATH,
  type HealthStatus,
  type LinkGraphResponse,
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

describe("links round-trip", () => {
  const sampleGraph: LinkGraphResponse = {
    edges: [
      { from: "", to: "notes" },
      { from: "notes", to: "projects" },
    ],
    broken: [{ from: "notes", target: "Ghost" }],
  };

  it("returns the link graph as JSON", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      getLinks: async () => sampleGraph,
    });

    const res = await request(app).get(LINKS_PATH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(sampleGraph);
  });

  it("returns 500 when building the link graph fails", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      getLinks: async () => {
        throw new Error("repo unreadable");
      },
    });

    const res = await request(app).get(LINKS_PATH);

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("repo unreadable");
  });

  it("does not mount the links endpoint when no reader is injected", async () => {
    const app = createApp({ getHealth: async () => okHealth });

    const res = await request(app).get(LINKS_PATH);

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

describe("note create round-trip", () => {
  it("creates a note under a parent and returns its new identity", async () => {
    const calls: Array<{ parent: string; name: string }> = [];
    const app = createApp({
      getHealth: async () => okHealth,
      createNote: async (parent, name) => {
        calls.push({ parent, name });
        return { path: "projects/ideas", file: "projects/ideas.md" };
      },
    });

    const res = await request(app)
      .post(NOTE_CREATE_PATH)
      .send({ parent: "projects", name: "Ideas" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: "projects/ideas", file: "projects/ideas.md" });
    expect(calls).toEqual([{ parent: "projects", name: "Ideas" }]);
  });

  it("treats a missing parent as the root note", async () => {
    let seenParent: string | undefined;
    const app = createApp({
      getHealth: async () => okHealth,
      createNote: async (parent) => {
        seenParent = parent;
        return { path: "ideas", file: "ideas.md" };
      },
    });

    const res = await request(app).post(NOTE_CREATE_PATH).send({ name: "Ideas" });

    expect(res.status).toBe(200);
    expect(seenParent).toBe("");
  });

  it("returns 400 when the name is missing or blank", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      createNote: async () => {
        throw new Error("must not be called");
      },
    });

    const missing = await request(app).post(NOTE_CREATE_PATH).send({ parent: "p" });
    const blank = await request(app)
      .post(NOTE_CREATE_PATH)
      .send({ parent: "p", name: "   " });

    expect(missing.status).toBe(400);
    expect(blank.status).toBe(400);
    expect(blank.body.error).toContain("name");
  });

  it("maps a NoteMutationError (e.g. duplicate) to a 400", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      createNote: async () => {
        throw new NoteMutationError("a note already exists at projects/ideas");
      },
    });

    const res = await request(app)
      .post(NOTE_CREATE_PATH)
      .send({ parent: "projects", name: "Ideas" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("already exists");
  });

  it("returns 500 when the engine fails unexpectedly", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      createNote: async () => {
        throw new Error("git exploded");
      },
    });

    const res = await request(app)
      .post(NOTE_CREATE_PATH)
      .send({ parent: "projects", name: "Ideas" });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("git exploded");
  });

  it("does not mount the create endpoint when no creator is injected", async () => {
    const app = createApp({ getHealth: async () => okHealth });

    const res = await request(app)
      .post(NOTE_CREATE_PATH)
      .send({ parent: "p", name: "x" });

    expect(res.status).toBe(404);
  });
});

describe("note rename round-trip", () => {
  it("renames a note and returns its new identity", async () => {
    const calls: Array<{ path: string; name: string }> = [];
    const app = createApp({
      getHealth: async () => okHealth,
      renameNote: async (path, name) => {
        calls.push({ path, name });
        return { path: "work", file: "work/_index.md" };
      },
    });

    const res = await request(app)
      .post(NOTE_RENAME_PATH)
      .send({ path: "projects", name: "Work" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: "work", file: "work/_index.md" });
    expect(calls).toEqual([{ path: "projects", name: "Work" }]);
  });

  it("returns 400 when path or name is missing", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      renameNote: async () => {
        throw new Error("must not be called");
      },
    });

    const noPath = await request(app).post(NOTE_RENAME_PATH).send({ name: "Work" });
    const noName = await request(app)
      .post(NOTE_RENAME_PATH)
      .send({ path: "projects" });

    expect(noPath.status).toBe(400);
    expect(noPath.body.error).toContain("path");
    expect(noName.status).toBe(400);
    expect(noName.body.error).toContain("name");
  });

  it("maps a NoteMutationError to a 400", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      renameNote: async () => {
        throw new NoteMutationError("cannot rename the root note");
      },
    });

    const res = await request(app)
      .post(NOTE_RENAME_PATH)
      .send({ path: "x", name: "Y" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("root note");
  });

  it("does not mount the rename endpoint when no renamer is injected", async () => {
    const app = createApp({ getHealth: async () => okHealth });

    const res = await request(app)
      .post(NOTE_RENAME_PATH)
      .send({ path: "x", name: "Y" });

    expect(res.status).toBe(404);
  });
});

describe("note move round-trip", () => {
  it("moves a note under a new parent and returns its new identity", async () => {
    const calls: Array<{ path: string; parent: string }> = [];
    const app = createApp({
      getHealth: async () => okHealth,
      moveNote: async (path, parent) => {
        calls.push({ path, parent });
        return { path: "b/only", file: "b/only.md" };
      },
    });

    const res = await request(app)
      .post(NOTE_MOVE_PATH)
      .send({ path: "a/only", parent: "b" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: "b/only", file: "b/only.md" });
    expect(calls).toEqual([{ path: "a/only", parent: "b" }]);
  });

  it("treats a missing parent as the root note", async () => {
    let seenParent: string | undefined;
    const app = createApp({
      getHealth: async () => okHealth,
      moveNote: async (_path, parent) => {
        seenParent = parent;
        return { path: "only", file: "only.md" };
      },
    });

    const res = await request(app).post(NOTE_MOVE_PATH).send({ path: "a/only" });

    expect(res.status).toBe(200);
    expect(seenParent).toBe("");
  });

  it("returns 400 when path is missing", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      moveNote: async () => {
        throw new Error("must not be called");
      },
    });

    const res = await request(app).post(NOTE_MOVE_PATH).send({ parent: "b" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("path");
  });

  it("maps a NoteMutationError (move into own subtree) to a 400", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      moveNote: async () => {
        throw new NoteMutationError("cannot move a into its own subtree");
      },
    });

    const res = await request(app)
      .post(NOTE_MOVE_PATH)
      .send({ path: "a", parent: "a/b" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("own subtree");
  });

  it("does not mount the move endpoint when no mover is injected", async () => {
    const app = createApp({ getHealth: async () => okHealth });

    const res = await request(app)
      .post(NOTE_MOVE_PATH)
      .send({ path: "a/only", parent: "b" });

    expect(res.status).toBe(404);
  });
});

describe("attachment upload round-trip", () => {
  it("stores an uploaded attachment and returns its path", async () => {
    const calls: Array<{ name: string; dataBase64: string }> = [];
    const app = createApp({
      getHealth: async () => okHealth,
      saveAttachment: async (name, dataBase64) => {
        calls.push({ name, dataBase64 });
        return { path: "assets/diagram.png" };
      },
    });

    const res = await request(app)
      .post(ATTACHMENT_PATH)
      .send({ name: "Diagram.png", dataBase64: "AQIDBA==" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: "assets/diagram.png" });
    // The name + bytes reach the saver verbatim (slug + decode are its job).
    expect(calls).toEqual([{ name: "Diagram.png", dataBase64: "AQIDBA==" }]);
  });

  it("returns 400 when the name is missing or blank", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      saveAttachment: async () => {
        throw new Error("must not be called");
      },
    });

    const missing = await request(app).post(ATTACHMENT_PATH).send({ dataBase64: "AQ==" });
    const blank = await request(app)
      .post(ATTACHMENT_PATH)
      .send({ name: "   ", dataBase64: "AQ==" });

    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("name");
    expect(blank.status).toBe(400);
  });

  it("returns 400 when the base64 data is missing", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      saveAttachment: async () => {
        throw new Error("must not be called");
      },
    });

    const res = await request(app).post(ATTACHMENT_PATH).send({ name: "diagram.png" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("dataBase64");
  });

  it("returns 500 when storing the attachment fails", async () => {
    const app = createApp({
      getHealth: async () => okHealth,
      saveAttachment: async () => {
        throw new Error("disk full");
      },
    });

    const res = await request(app)
      .post(ATTACHMENT_PATH)
      .send({ name: "diagram.png", dataBase64: "AQ==" });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("disk full");
  });

  it("does not mount the attachment endpoint when no saver is injected", async () => {
    const app = createApp({ getHealth: async () => okHealth });

    const res = await request(app)
      .post(ATTACHMENT_PATH)
      .send({ name: "diagram.png", dataBase64: "AQ==" });

    expect(res.status).toBe(404);
  });
});

describe("attachment static hosting", () => {
  let assetsDir: string;

  beforeEach(async () => {
    assetsDir = await mkdtemp(join(tmpdir(), "stout-assets-"));
  });

  afterEach(async () => {
    await rm(assetsDir, { recursive: true, force: true });
  });

  it("serves stored attachments read-only at /assets", async () => {
    await writeFile(join(assetsDir, "diagram.txt"), "hello", "utf8");
    const app = createApp({ getHealth: async () => okHealth, assetsDir });

    const res = await request(app).get("/assets/diagram.txt");

    expect(res.status).toBe(200);
    expect(res.text).toBe("hello");
  });

  it("does not host /assets when no assetsDir is configured", async () => {
    const app = createApp({ getHealth: async () => okHealth });

    const res = await request(app).get("/assets/diagram.txt");

    expect(res.status).toBe(404);
  });
});
