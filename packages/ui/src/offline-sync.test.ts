import { describe, expect, it, vi } from "vitest";
import type { ConflictNotification, SyncTrigger } from "@stout/core";
import { createOfflineSyncRunner } from "./offline-sync.js";

const notification: ConflictNotification = {
  notePath: "notes/daily",
  noteTitle: "Daily",
  copyPath: "notes/daily (conflict 20260101-000000)",
  copyTitle: "Daily (conflict 20260101-000000)",
  message: "A conflicting edit was saved as a copy.",
};

describe("createOfflineSyncRunner", () => {
  it("is a no-op that still resolves when no reconcile is configured", async () => {
    const notify = vi.fn();
    const onChanged = vi.fn();
    const runner = createOfflineSyncRunner({ notify, onChanged });

    await expect(runner("launch")).resolves.toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("forwards every conflict notification to the sink and signals onChanged", async () => {
    const notify = vi.fn();
    const onChanged = vi.fn();
    const reconcile = vi.fn(async () => [notification]);
    const runner = createOfflineSyncRunner({ reconcile, notify, onChanged });

    await runner("manual");

    expect(reconcile).toHaveBeenCalledWith("manual");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(notification);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("signals onChanged but never notifies when the reconcile merged cleanly", async () => {
    const notify = vi.fn();
    const onChanged = vi.fn();
    const reconcile = vi.fn(async () => []);
    const runner = createOfflineSyncRunner({ reconcile, notify, onChanged });

    await runner("timer");

    expect(notify).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("passes the triggering reason through to reconcile", async () => {
    const seen: SyncTrigger[] = [];
    const runner = createOfflineSyncRunner({
      reconcile: async (trigger) => {
        seen.push(trigger);
        return [];
      },
    });

    await runner("reconnect");
    await runner("focus");

    expect(seen).toEqual(["reconnect", "focus"]);
  });
});
