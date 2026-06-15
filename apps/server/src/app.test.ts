import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  HEALTH_PATH,
  TREE_PATH,
  type HealthStatus,
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
