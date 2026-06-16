import { afterEach, describe, expect, it } from "vitest";
import type { SyncClock, SyncTrigger } from "@stout/core";
import { createSyncController, type SyncController } from "./sync-cadence-controller.js";

/** Flush the microtask queue so fire-and-forget `request(...)` calls settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

class VirtualClock implements SyncClock {
  time = 0;
  now(): number {
    return this.time;
  }
}

let controller: SyncController | null = null;
afterEach(() => {
  controller?.stop();
  controller = null;
});

describe("createSyncController", () => {
  it("maps browser triggers to scheduler requests and stops cleanly", async () => {
    const clock = new VirtualClock();
    const calls: SyncTrigger[] = [];
    // A large period so the periodic timer never fires during the test.
    controller = createSyncController(
      async (trigger) => {
        calls.push(trigger);
      },
      { clock, minIntervalMs: 5000, periodMs: 1_000_000 },
    );

    // Construction fires a one-shot launch sync.
    await flush();
    expect(calls).toEqual(["launch"]);

    // `online` → reconnect (forced, always runs).
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(calls).toEqual(["launch", "reconnect"]);

    // window `focus` → focus, once past the throttle window.
    clock.time = 10000;
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(calls).toEqual(["launch", "reconnect", "focus"]);

    // Becoming visible also requests a focus sync.
    clock.time = 20000;
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(calls).toEqual(["launch", "reconnect", "focus", "focus"]);

    // A manual request always runs.
    await controller.syncNow();
    expect(calls).toEqual(["launch", "reconnect", "focus", "focus", "manual"]);

    // After stop(), detached listeners no longer trigger syncs.
    controller.stop();
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(calls).toEqual(["launch", "reconnect", "focus", "focus", "manual"]);
  });

  it("throttles a rapid window focus (the scheduler's policy), unlike forced triggers", async () => {
    const clock = new VirtualClock();
    const calls: SyncTrigger[] = [];
    controller = createSyncController(
      async (trigger) => {
        calls.push(trigger);
      },
      { clock, minIntervalMs: 5000, periodMs: 1_000_000 },
    );
    await flush(); // launch at t=0

    // A focus at the same instant as launch is within the throttle window.
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(calls).toEqual(["launch"]);
  });
});
