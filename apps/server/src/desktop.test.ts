import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { ensureWorkspaceRepo, loadRepoPaths, startLocalWorkspace } from "./desktop.js";
import type { LocalWorkspace, RepoPaths } from "./desktop.js";

let dataDir: string;
let paths: RepoPaths;
let uiDir: string;
let workspace: LocalWorkspace;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "stout-desktop-"));
  paths = loadRepoPaths({ STOUT_DATA_DIR: join(dataDir, "data") });
  await ensureWorkspaceRepo(paths);
  // A throwaway UI dir so the host hosts *something* without depending on the
  // built @stout/ui assets — the API is what these tests exercise.
  uiDir = join(dataDir, "ui");
  await mkdir(uiDir, { recursive: true });
  await writeFile(join(uiDir, "index.html"), "<!doctype html><title>Stout</title>", "utf8");
  workspace = await startLocalWorkspace({ cloneDir: paths.cloneDir, uiDir });
});

afterEach(async () => {
  await workspace.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("startLocalWorkspace", () => {
  it("binds a loopback URL", () => {
    expect(workspace.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(workspace.port).toBeGreaterThan(0);
  });

  it("serves health as ok with no database (local-first)", async () => {
    const res = await request(workspace.url).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      service: "stout",
      database: false,
      migration: 0,
    });
  });

  it("serves the note tree over the same API as the web server", async () => {
    const res = await request(workspace.url).get("/api/tree");
    expect(res.status).toBe(200);
    expect(res.body.root).toMatchObject({ path: "", file: "_index.md", kind: "parent" });
  });

  it("reads the seeded starter note by identity", async () => {
    const res = await request(workspace.url).get("/api/note").query({ path: "" });
    expect(res.status).toBe(200);
    expect(res.body.markdown).toContain("# Welcome to Stout");
  });

  it("saves an edit to the local clone and reads it back", async () => {
    const save = await request(workspace.url)
      .post("/api/note")
      .send({ path: "", markdown: "# Home\n\nLocal edit.\n" });
    expect(save.status).toBe(200);

    const reload = await request(workspace.url).get("/api/note").query({ path: "" });
    expect(reload.body.markdown).toBe("# Home\n\nLocal edit.\n");
  });

  it("creates a note through the mutation API", async () => {
    const res = await request(workspace.url)
      .post("/api/note/create")
      .send({ parent: "", name: "Desktop Idea" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: "desktop-idea", file: "desktop-idea.md" });
  });

  it("serves the hosted UI for a non-API route (SPA fallback)", async () => {
    const res = await request(workspace.url).get("/some/client/route");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Stout");
  });
});
