import { describe, expect, it } from "vitest";
import { SyncScheduler, type SyncClock, type SyncTrigger } from "./index.js";

/** A clock whose time the test sets explicitly, so cadence is deterministic. */
class VirtualClock implements SyncClock {
  time = 0;
  now(): number {
    return this.time;
  }
}

/** Flush the entire microtask queue by crossing one macrotask boundary. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A runner that resolves immediately, recording each call's trigger. `fail`
 * makes the next runs throw, exercising the scheduler's error capture.
 */
class ImmediateRunner {
  readonly calls: SyncTrigger[] = [];
  fail = false;
  readonly run = async (trigger: SyncTrigger): Promise<void> => {
    this.calls.push(trigger);
    if (this.fail) throw new Error("boom");
  };
}

/**
 * A runner each of whose calls blocks until released (FIFO), so a test can hold a
 * sync "in flight" and issue more requests to observe single-flight coalescing.
 */
class GatedRunner {
  readonly calls: SyncTrigger[] = [];
  private readonly gates: Deferred<void>[] = [];

  readonly run = (trigger: SyncTrigger): Promise<void> => {
    this.calls.push(trigger);
    const gate = deferred<void>();
    this.gates.push(gate);
    return gate.promise;
  };

  /** Resolve the oldest still-blocked call and let the scheduler advance. */
  async releaseNext(): Promise<void> {
    const gate = this.gates.shift();
    if (!gate) throw new Error("no pending runner call to release");
    gate.resolve();
    await flush();
  }
}

describe("SyncScheduler.request", () => {
  it("runs the injected runner and records a successful run", async () => {
    const clock = new VirtualClock();
    clock.time = 42;
    const runner = new ImmediateRunner();
    const scheduler = new SyncScheduler(runner.run, { clock });

    const outcome = await scheduler.request("manual");

    expect(outcome).toBe("ran");
    expect(runner.calls).toEqual(["manual"]);
    expect(scheduler.runs).toEqual([
      { trigger: "manual", startedAt: 42, finishedAt: 42, ok: true },
    ]);
  });

  it("records a failed run when the runner throws, without rejecting the request", async () => {
    const clock = new VirtualClock();
    const runner = new ImmediateRunner();
    runner.fail = true;
    const scheduler = new SyncScheduler(runner.run, { clock });

    const outcome = await scheduler.request("manual");

    expect(outcome).toBe("ran");
    expect(scheduler.runs).toEqual([
      { trigger: "manual", startedAt: 0, finishedAt: 0, ok: false, error: "boom" },
    ]);
  });

  it("runs a focus sync, then throttles a rapid second focus, then runs again after the interval", async () => {
    const clock = new VirtualClock();
    const runner = new ImmediateRunner();
    const scheduler = new SyncScheduler(runner.run, { clock, minIntervalMs: 5000 });

    clock.time = 1000;
    expect(await scheduler.request("focus")).toBe("ran");

    clock.time = 3000; // only 2s later — within the throttle window
    expect(await scheduler.request("focus")).toBe("throttled");

    clock.time = 7000; // 6s after the last run — past the window
    expect(await scheduler.request("focus")).toBe("ran");

    expect(runner.calls).toEqual(["focus", "focus"]);
  });

  it("never throttles the forced triggers (launch, reconnect, manual, timer)", async () => {
    const clock = new VirtualClock();
    const runner = new ImmediateRunner();
    const scheduler = new SyncScheduler(runner.run, { clock, minIntervalMs: 5000 });

    // All requested at the same instant — a throttled trigger would be dropped.
    for (const trigger of ["launch", "reconnect", "manual", "timer"] as const) {
      expect(await scheduler.request(trigger)).toBe("ran");
    }
    expect(runner.calls).toEqual(["launch", "reconnect", "manual", "timer"]);
  });

  it("is single-flight: mid-flight triggers coalesce into one strongest follow-up", async () => {
    const clock = new VirtualClock();
    const runner = new GatedRunner();
    const scheduler = new SyncScheduler(runner.run, { clock });

    const ran = scheduler.request("manual"); // starts and blocks in the runner
    expect(scheduler.isRunning).toBe(true);
    expect(runner.calls).toEqual(["manual"]);

    // Three triggers arrive mid-flight: all coalesce into a single follow-up,
    // labelled with the strongest of them (reconnect=4 outranks timer=2).
    expect(await scheduler.request("timer")).toBe("coalesced");
    expect(await scheduler.request("reconnect")).toBe("coalesced");
    expect(await scheduler.request("timer")).toBe("coalesced");
    expect(runner.calls).toEqual(["manual"]); // nothing extra ran yet

    await runner.releaseNext(); // manual finishes → the one follow-up runs
    expect(runner.calls).toEqual(["manual", "reconnect"]);

    await runner.releaseNext(); // follow-up finishes → queue drained
    expect(await ran).toBe("ran");
    expect(scheduler.isRunning).toBe(false);
    expect(runner.calls).toEqual(["manual", "reconnect"]);
    expect(scheduler.runs.map((run) => run.trigger)).toEqual(["manual", "reconnect"]);
  });
});

describe("SyncScheduler.tick", () => {
  it("fires a timer sync on the first tick", async () => {
    const clock = new VirtualClock();
    const runner = new ImmediateRunner();
    const scheduler = new SyncScheduler(runner.run, { clock, periodMs: 60000 });

    await scheduler.tick(0);

    expect(runner.calls).toEqual(["timer"]);
  });

  it("does not re-fire until a full period has elapsed", async () => {
    const clock = new VirtualClock();
    const runner = new ImmediateRunner();
    const scheduler = new SyncScheduler(runner.run, { clock, periodMs: 60000 });

    await scheduler.tick(0); // first tick always fires
    await scheduler.tick(30000); // 30s < 60s — no fire
    expect(runner.calls).toEqual(["timer"]);

    await scheduler.tick(60000); // a full period since the last fire — fires
    expect(runner.calls).toEqual(["timer", "timer"]);
  });
});
