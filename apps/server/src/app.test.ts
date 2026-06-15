import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  HEALTH_PATH,
  NOTE_PATH,
  TREE_PATH,
  type HealthStatus,
  type NoteContentResponse,
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
