/**
 * Node side of `core/hub-sync`: the `git`-shelling {@link HubRemoteEngine}.
 *
 * Where the pure `core/hub-sync` owns the *policy* (clone-then-sync, and the
 * token-in-URL credential maths), this owns the *mechanism* — running `git clone`
 * / `git pull` / `git push` against the **hub** for the desktop's local working
 * clone. It is the hub-remote counterpart to {@link NodeGitEngine}: the only place
 * (besides that engine) that touches the `git` binary.
 *
 * The token only ever appears in an argv to a single `git` invocation (passed in
 * as the already-authenticated URL); it is **never** persisted to `.git/config` —
 * after cloning, the `origin` remote is reset to the credential-free URL via
 * {@link stripRemoteCredentials}. Tradeoff: the token is transiently visible to a
 * process listing for the duration of the op, which we accept over the
 * alternative of writing it to disk in the remote config. See
 * `docs/adr/0010-electron-local-first.md`.
 */

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { stripRemoteCredentials, type HubRemoteEngine } from "@stout/core";

const run = promisify(execFile);

/**
 * A {@link HubRemoteEngine} that drives a local working clone at `cloneDir`
 * against a hub remote by shelling out to `git`.
 */
export class NodeHubRemoteEngine implements HubRemoteEngine {
  constructor(private readonly cloneDir: string) {}

  /** Whether the local working clone already exists (has a `.git`). */
  async hasLocalClone(): Promise<boolean> {
    try {
      await access(join(this.cloneDir, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clone the hub into `cloneDir` using the authenticated URL, then immediately
   * reset `origin` to the credential-free URL so the token is not persisted in
   * `.git/config`, and set a local identity so desktop commits never depend on a
   * global `git` config. Best-effort checks out `branch` when it differs from the
   * cloned default (ignored for an empty hub that has no branch yet).
   */
  async cloneFromHub(authenticatedUrl: string, branch: string): Promise<void> {
    await run("git", ["clone", authenticatedUrl, this.cloneDir]);
    await run("git", [
      "-C",
      this.cloneDir,
      "remote",
      "set-url",
      "origin",
      stripRemoteCredentials(authenticatedUrl),
    ]);
    await run("git", ["-C", this.cloneDir, "config", "user.email", "stout@localhost"]);
    await run("git", ["-C", this.cloneDir, "config", "user.name", "Stout"]);
    await run("git", ["-C", this.cloneDir, "checkout", branch]).catch(() => undefined);
  }

  /**
   * Pull `branch` from the hub into the local clone, merging (never rebasing) and
   * never opening an editor — so an unattended desktop sync integrates remote work
   * without prompting.
   */
  async pullFromHub(authenticatedUrl: string, branch: string): Promise<void> {
    await run("git", [
      "-C",
      this.cloneDir,
      "pull",
      "--no-rebase",
      "--no-edit",
      authenticatedUrl,
      branch,
    ]);
  }

  /** Push the local `HEAD` to the hub's `branch`. */
  async pushToHub(authenticatedUrl: string, branch: string): Promise<void> {
    await run("git", [
      "-C",
      this.cloneDir,
      "push",
      authenticatedUrl,
      `HEAD:${branch}`,
    ]);
  }
}
