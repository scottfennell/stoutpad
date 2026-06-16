import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalizeMarkdown, InMemoryTokenStore, syncRemoteBoundary } from "@stout/core";
import { loadRemoteConfig, NodeRemoteBoundaryEngine } from "./remote-engine.js";

const run = promisify(execFile);

const BASE = ["# Daily Log", "", "Line A", "", "Line B", "", "Line C", ""].join("\n");

/** Replace one line of {@link BASE}, returning canonical Markdown. */
function edit(line: string, replacement: string): string {
  return canonicalizeMarkdown(BASE.replace(line, replacement));
}

let dataDir: string;
let externalDir: string;
let cloneDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "stout-remote-"));
  externalDir = join(dataDir, "external.git");
  cloneDir = join(dataDir, "clone");
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** Create a bare "external remote" seeded with {@link BASE} at `notes/log.md`. */
async function seedExternal(): Promise<void> {
  await run("git", ["init", "--bare", "-b", "main", externalDir]);
  const seed = join(dataDir, "seed");
  await run("git", ["clone", externalDir, seed]);
  await identity(seed);
  await writeFileIn(seed, "notes/log.md", canonicalizeMarkdown(BASE));
  await run("git", ["-C", seed, "add", "-A"]);
  await run("git", ["-C", seed, "commit", "-m", "seed log"]);
  await run("git", ["-C", seed, "push", "origin", "main"]);
  await rm(seed, { recursive: true, force: true });
}

/** Set a local git identity so commits never need a global config. */
async function identity(dir: string): Promise<void> {
  await run("git", ["-C", dir, "config", "user.email", "test@localhost"]);
  await run("git", ["-C", dir, "config", "user.name", "Test"]);
}

/** Write `content` to `file` under `dir`, creating parent directories. */
async function writeFileIn(dir: string, file: string, content: string): Promise<void> {
  const full = join(dir, file);
  await run("mkdir", ["-p", join(dir, file.slice(0, file.lastIndexOf("/")) || ".")]);
  await writeFile(full, content, "utf8");
}

/** A second actor pushes an edit to the external remote's `main`. */
async function otherActorEdits(line: string, replacement: string): Promise<void> {
  const other = join(dataDir, "other");
  await run("git", ["clone", externalDir, other]);
  await identity(other);
  await writeFile(join(other, "notes/log.md"), edit(line, replacement), "utf8");
  await run("git", ["-C", other, "commit", "-am", "remote edit"]);
  await run("git", ["-C", other, "push", "origin", "main"]);
  await rm(other, { recursive: true, force: true });
}

/** Read a file at a ref in a repo, or `null` when it is absent there. */
async function showAt(dir: string, ref: string, file: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", dir, "show", `${ref}:${file}`]);
    return stdout;
  } catch {
    return null;
  }
}

const noToken = new InMemoryTokenStore(null);

describe("loadRemoteConfig", () => {
  it("returns null when no external remote is configured", () => {
    expect(loadRemoteConfig({})).toBeNull();
  });

  it("reads the URL, branch, and token (STOUT_ and bare aliases)", () => {
    expect(
      loadRemoteConfig({ STOUT_REMOTE_URL: "https://h/r.git", STOUT_REMOTE_TOKEN: "t" }),
    ).toEqual({ config: { remoteUrl: "https://h/r.git", branch: undefined }, token: "t" });

    expect(loadRemoteConfig({ REMOTE_URL: "https://h/r.git", REMOTE_BRANCH: "notes" })).toEqual({
      config: { remoteUrl: "https://h/r.git", branch: "notes" },
      token: null,
    });
  });
});

describe("syncRemoteBoundary over a NodeRemoteBoundaryEngine", () => {
  it("auto-merges a non-overlapping external edit and pushes it back (zero data loss)", async () => {
    await seedExternal();
    await run("git", ["clone", externalDir, cloneDir]);
    await identity(cloneDir);

    // A local save lands on the server's `main`…
    await writeFile(join(cloneDir, "notes/log.md"), edit("Line A", "Line A local"), "utf8");
    await run("git", ["-C", cloneDir, "commit", "-am", "local edit"]);
    // …while another actor edits a different region on the external remote.
    await otherActorEdits("Line C", "Line C remote");

    const engine = new NodeRemoteBoundaryEngine(cloneDir);
    const result = await syncRemoteBoundary(
      engine,
      noToken,
      { remoteUrl: externalDir, branch: "main" },
      { marker: "M" },
    );

    expect(result.action).toBe("sync");
    expect(result.conflicts).toEqual([]);

    // Both edits survive locally…
    const local = await readFile(join(cloneDir, "notes/log.md"), "utf8");
    expect(local).toContain("Line A local");
    expect(local).toContain("Line C remote");

    // …and were published back to the external remote.
    const remote = await showAt(externalDir, "main", "notes/log.md");
    expect(remote).toContain("Line A local");
    expect(remote).toContain("Line C remote");
  });

  it("keeps both versions on a conflicting external edit and notifies", async () => {
    await seedExternal();
    await run("git", ["clone", externalDir, cloneDir]);
    await identity(cloneDir);

    // Both sides edit the SAME region differently → a true conflict.
    await writeFile(join(cloneDir, "notes/log.md"), edit("Line B", "Line B local"), "utf8");
    await run("git", ["-C", cloneDir, "commit", "-am", "local edit"]);
    await otherActorEdits("Line B", "Line B remote");

    const engine = new NodeRemoteBoundaryEngine(cloneDir);
    const result = await syncRemoteBoundary(
      engine,
      noToken,
      { remoteUrl: externalDir, branch: "main" },
      { marker: "M" },
    );

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].copyPath).toBe("notes/log-conflict-copy-m");

    // The note keeps the incoming (external) version…
    const note = await readFile(join(cloneDir, "notes/log.md"), "utf8");
    expect(note).toContain("Line B remote");
    expect(note).not.toContain("Line B local");
    // …and the local version is preserved verbatim in a sibling conflict copy.
    const copy = await readFile(join(cloneDir, "notes/log-conflict-copy-m.md"), "utf8");
    expect(copy).toContain("Line B local");

    // Both the resolved note and the conflict copy reached the external remote.
    expect(await showAt(externalDir, "main", "notes/log.md")).toContain("Line B remote");
    expect(await showAt(externalDir, "main", "notes/log-conflict-copy-m.md")).toContain(
      "Line B local",
    );
  });

  it("seeds an empty external remote by publishing local main", async () => {
    // An empty bare remote (no `main` branch yet) and a local repo with content.
    await run("git", ["init", "--bare", "-b", "main", externalDir]);
    await run("git", ["init", "-b", "main", cloneDir]);
    await identity(cloneDir);
    await writeFile(join(cloneDir, "_index.md"), "# Home\n", "utf8");
    await run("git", ["-C", cloneDir, "add", "-A"]);
    await run("git", ["-C", cloneDir, "commit", "-m", "seed"]);

    const engine = new NodeRemoteBoundaryEngine(cloneDir);
    const result = await syncRemoteBoundary(engine, noToken, { remoteUrl: externalDir });

    expect(result.action).toBe("publish");
    expect(await showAt(externalDir, "main", "_index.md")).toBe("# Home\n");
  });
});
