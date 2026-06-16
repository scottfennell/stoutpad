import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeHubRemoteEngine } from "./hub-engine.js";

const run = promisify(execFile);

let dataDir: string;
let hubDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "stout-hub-"));
  hubDir = await makeHub(join(dataDir, "hub.git"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** Create a bare "hub" repo seeded with one commit on `main`, return its path. */
async function makeHub(hubPath: string): Promise<string> {
  await run("git", ["init", "--bare", "-b", "main", hubPath]);
  const seed = join(dataDir, "seed");
  await run("git", ["clone", hubPath, seed]);
  await run("git", ["-C", seed, "config", "user.email", "seed@localhost"]);
  await run("git", ["-C", seed, "config", "user.name", "Seed"]);
  await writeFile(join(seed, "_index.md"), "# Hub\n", "utf8");
  await run("git", ["-C", seed, "add", "-A"]);
  await run("git", ["-C", seed, "commit", "-m", "seed"]);
  await run("git", ["-C", seed, "push", "origin", "main"]);
  await rm(seed, { recursive: true, force: true });
  return hubPath;
}

/** Commit subjects on a ref, newest first. */
async function subjects(dir: string, ref: string): Promise<string[]> {
  const { stdout } = await run("git", ["-C", dir, "log", "--format=%s", ref]);
  return stdout.split("\n").filter((line) => line.length > 0);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("NodeHubRemoteEngine.hasLocalClone", () => {
  it("is false before a clone and true after", async () => {
    const cloneDir = join(dataDir, "clone");
    const engine = new NodeHubRemoteEngine(cloneDir);

    expect(await engine.hasLocalClone()).toBe(false);

    await engine.cloneFromHub(hubDir, "main");

    expect(await engine.hasLocalClone()).toBe(true);
  });
});

describe("NodeHubRemoteEngine.cloneFromHub", () => {
  it("clones the hub, sets a local identity, and does not persist credentials", async () => {
    const cloneDir = join(dataDir, "clone");
    const engine = new NodeHubRemoteEngine(cloneDir);

    await engine.cloneFromHub(hubDir, "main");

    // The seeded note came down…
    expect(await readFile(join(cloneDir, "_index.md"), "utf8")).toBe("# Hub\n");
    // …origin points at the credential-free hub URL (a local path here)…
    const { stdout: origin } = await run("git", [
      "-C",
      cloneDir,
      "remote",
      "get-url",
      "origin",
    ]);
    expect(origin.trim()).toBe(hubDir);
    // …and a local identity is configured so commits never need a global config.
    const { stdout: email } = await run("git", ["-C", cloneDir, "config", "user.email"]);
    expect(email.trim()).toBe("stout@localhost");
  });
});

describe("NodeHubRemoteEngine push/pull round-trip", () => {
  it("pushes a local commit up to the hub", async () => {
    const cloneDir = join(dataDir, "clone");
    const engine = new NodeHubRemoteEngine(cloneDir);
    await engine.cloneFromHub(hubDir, "main");

    await writeFile(join(cloneDir, "note.md"), "# Note\n", "utf8");
    await run("git", ["-C", cloneDir, "add", "-A"]);
    await run("git", ["-C", cloneDir, "commit", "-m", "add note"]);
    await engine.pushToHub(hubDir, "main");

    // The hub's main now carries the pushed commit.
    expect(await subjects(hubDir, "main")).toContain("add note");
  });

  it("pulls a commit another clone pushed to the hub", async () => {
    const cloneDir = join(dataDir, "clone");
    const engine = new NodeHubRemoteEngine(cloneDir);
    await engine.cloneFromHub(hubDir, "main");

    // A second, independent clone pushes a change to the hub.
    const other = join(dataDir, "other");
    await run("git", ["clone", hubDir, other]);
    await run("git", ["-C", other, "config", "user.email", "other@localhost"]);
    await run("git", ["-C", other, "config", "user.name", "Other"]);
    await writeFile(join(other, "remote.md"), "# Remote\n", "utf8");
    await run("git", ["-C", other, "add", "-A"]);
    await run("git", ["-C", other, "commit", "-m", "remote note"]);
    await run("git", ["-C", other, "push", "origin", "main"]);

    // Our clone has not seen it yet; pulling brings it in.
    expect(await exists(join(cloneDir, "remote.md"))).toBe(false);
    await engine.pullFromHub(hubDir, "main");
    expect(await readFile(join(cloneDir, "remote.md"), "utf8")).toBe("# Remote\n");
  });
});
