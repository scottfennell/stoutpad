/**
 * Node side of `core/remote-sync`: the `git`-shelling {@link RemoteBoundaryEngine}.
 *
 * Where the pure `core/remote-sync` owns the *policy* (fetch → reconcile divergent
 * history with the `core/conflict` merge → record a merge → push), this owns the
 * *mechanism* against a configurable **external remote** (e.g. a GitHub repo). It
 * extends {@link NodeGitEngine} — so it already reads/writes/commits `main` for the
 * HTTP layer — and adds the handful of remote-boundary `git` ops the orchestrator
 * needs: fetch the external branch, diff it against `main`, read a file at any ref,
 * record a tree-preserving merge so the push fast-forwards, and push.
 *
 * The boundary merge uses `git merge -s ours`: the reconciled content has already
 * been applied to `main` by the conflict policy, so all this commit does is record
 * the external tip as a second parent (making the push a fast-forward) while
 * keeping our tree. We never let `git` do the content merge — divergent history is
 * merged by the `core/conflict` policy, the same one the multi-device story uses.
 *
 * Like {@link NodeHubRemoteEngine}, the access token only ever appears in the argv
 * of a single `git` fetch/push (passed in as the already-authenticated URL); it is
 * never written to `.git/config`. See
 * `docs/adr/0012-external-remote-and-server-boundary-merge.md`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BoundaryFetch, RemoteBoundaryEngine, RemoteConfig } from "@stout/core";
import { NodeGitEngine } from "./git-engine.js";

const run = promisify(execFile);

/**
 * A {@link RemoteBoundaryEngine} that drives the server's working clone at
 * `cloneDir` against an external remote by shelling out to `git`, on top of the
 * `main` reads/writes it inherits from {@link NodeGitEngine}.
 */
export class NodeRemoteBoundaryEngine extends NodeGitEngine implements RemoteBoundaryEngine {
  /**
   * Fetch `branch` from the external remote and report its tip sha + the merge
   * base it shares with local `main`. The clone is forced onto a clean `main`
   * first so the diff/merge baseline is stable. Resolves `null` when the remote
   * does not have `branch` yet (an empty remote), so the caller seeds it.
   */
  async fetchBoundary(authenticatedUrl: string, branch: string): Promise<BoundaryFetch | null> {
    await this.boundaryGit(["checkout", "-f", "main"]).catch(() => undefined);
    try {
      await this.boundaryGit(["fetch", authenticatedUrl, branch]);
    } catch {
      return null; // the remote has no such branch yet
    }
    const { stdout: tip } = await this.boundaryGit(["rev-parse", "FETCH_HEAD"]);
    const ref = tip.trim();

    let baseRef: string | null = null;
    try {
      const { stdout } = await this.boundaryGit(["merge-base", "HEAD", ref]);
      baseRef = stdout.trim() || null;
    } catch {
      baseRef = null; // unrelated histories: no common ancestor
    }
    return { ref, baseRef };
  }

  /** Repo-relative `.md` files that differ between `fromRef` and `toRef`. */
  async changedNoteFiles(fromRef: string, toRef: string): Promise<string[]> {
    const { stdout } = await this.boundaryGit(["diff", "--name-only", "-z", fromRef, toRef]);
    return stdout
      .split("\0")
      .filter((path) => path.length > 0 && path.toLowerCase().endsWith(".md"));
  }

  /** Read a file's content at a specific ref, or `null` when it is absent there. */
  async readFileAt(ref: string, file: string): Promise<string | null> {
    try {
      const { stdout } = await this.boundaryGit(["show", `${ref}:${file}`]);
      return stdout;
    } catch {
      return null;
    }
  }

  /**
   * Record a merge of `ref` into `main` that keeps the current (already
   * reconciled) tree and only adds `ref` as a second parent — `-s ours`. This
   * makes `ref` an ancestor of `main` so the subsequent push is a fast-forward,
   * without letting `git` touch the content (the `core/conflict` policy already
   * merged it). A no-op when `ref` is already an ancestor ("Already up to date").
   */
  async recordBoundaryMerge(ref: string, message: string): Promise<void> {
    await this.boundaryGit(["checkout", "-f", "main"]).catch(() => undefined);
    await this.boundaryGit([
      "merge",
      "-s",
      "ours",
      "--no-edit",
      "--allow-unrelated-histories",
      "-m",
      message,
      ref,
    ]);
  }

  /** Push local `main` to the external remote's `branch`. */
  async pushBoundary(authenticatedUrl: string, branch: string): Promise<void> {
    await this.boundaryGit(["push", authenticatedUrl, `HEAD:${branch}`]);
  }

  /** Run a `git` subcommand in the working clone. */
  private boundaryGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return run("git", ["-C", this.cloneDir, ...args]);
  }
}

/** The external remote the server should sync with, plus its access token. */
export interface RemoteSetup {
  /** Where to reach the external remote (URL + optional branch). */
  config: RemoteConfig;
  /** The access token to authenticate with, or `null` for an unauthenticated remote. */
  token: string | null;
}

/**
 * Resolve the external-remote configuration from the environment, or `null` when
 * none is set (the default: the server uses only its internal bare repo).
 *
 * `STOUT_REMOTE_URL` (alias `REMOTE_URL`) selects the external remote;
 * `STOUT_REMOTE_BRANCH` (alias `REMOTE_BRANCH`) overrides the branch; and the
 * credential is `STOUT_REMOTE_TOKEN` (alias `REMOTE_TOKEN`) — read **server-side**
 * only, never sent to clients, and materialised into a URL only for a single
 * `git` op (see {@link NodeRemoteBoundaryEngine}).
 */
export function loadRemoteConfig(env: NodeJS.ProcessEnv = process.env): RemoteSetup | null {
  const remoteUrl = env.STOUT_REMOTE_URL ?? env.REMOTE_URL;
  if (remoteUrl === undefined || remoteUrl === "") return null;
  const branch = env.STOUT_REMOTE_BRANCH ?? env.REMOTE_BRANCH;
  const token = env.STOUT_REMOTE_TOKEN ?? env.REMOTE_TOKEN ?? null;
  return { config: { remoteUrl, branch }, token };
}
