/**
 * Browser wiring for the core sync **scheduler**.
 *
 * `core/sync-cadence` decides *when* to sync but owns no DOM and no real timers.
 * This module is the thin adapter that binds the browser's connectivity/focus
 * signals and a periodic timer to a {@link SyncScheduler}:
 *
 * - `online`            → a `reconnect` sync (we just regained the network);
 * - window `focus` and becoming visible → a (throttled) `focus` sync;
 * - `setInterval`       → a periodic `timer` sync (self-gated by the scheduler);
 * - construction        → a one-shot `launch` sync;
 * - {@link SyncController.syncNow} → a `manual` sync (e.g. a "Sync now" button).
 *
 * The decision logic (single-flight, coalescing, throttling) stays in the pure
 * core scheduler; this only translates events into `request(...)` calls. The
 * event target, document, and clock are injectable so it is unit tested in jsdom
 * without real connectivity.
 *
 * See `docs/adr/0011-pwa-offline-and-conflict-policy.md`.
 */

import {
  DEFAULT_SYNC_PERIOD_MS,
  SyncScheduler,
  type RequestOutcome,
  type SyncClock,
  type SyncRunner,
  type SyncSchedulerOptions,
} from "@stout/core";

/** A live sync controller: the scheduler, a manual trigger, and a teardown. */
export interface SyncController {
  /** The underlying scheduler (read {@link SyncScheduler.runs}, request manually). */
  scheduler: SyncScheduler;
  /** Request a `manual` sync now (always runs; never throttled). */
  syncNow: () => Promise<RequestOutcome>;
  /** Detach every listener and stop the periodic timer. Idempotent. */
  stop: () => void;
}

/** Options for {@link createSyncController}. */
export interface SyncControllerOptions extends SyncSchedulerOptions {
  /** Event target for `online`/`focus` (defaults to `window`). */
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
  /** Document for `visibilitychange` + visibility state (defaults to `document`). */
  documentRef?: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
  /** Periodic timer period (ms); defaults to {@link DEFAULT_SYNC_PERIOD_MS}. */
  periodMs?: number;
  /** Injected clock (forwarded to the scheduler). */
  clock?: SyncClock;
}

/**
 * Create and start a {@link SyncController}: construct a {@link SyncScheduler} over
 * `runner`, bind the browser triggers, fire the initial `launch` sync, and start
 * the periodic timer. Call {@link SyncController.stop} to detach everything (e.g.
 * a React effect cleanup).
 */
export function createSyncController(
  runner: SyncRunner,
  options: SyncControllerOptions = {},
): SyncController {
  const {
    target = window,
    documentRef = document,
    periodMs = DEFAULT_SYNC_PERIOD_MS,
    ...schedulerOptions
  } = options;
  const scheduler = new SyncScheduler(runner, { ...schedulerOptions, periodMs });

  const fire = (trigger: Parameters<SyncScheduler["request"]>[0]) => {
    void scheduler.request(trigger).catch(() => undefined);
  };

  const onOnline = (): void => fire("reconnect");
  const onFocus = (): void => fire("focus");
  const onVisibility = (): void => {
    if (documentRef.visibilityState === "visible") fire("focus");
  };

  target.addEventListener("online", onOnline);
  target.addEventListener("focus", onFocus);
  documentRef.addEventListener("visibilitychange", onVisibility);

  const interval = setInterval(() => {
    void scheduler.tick().catch(() => undefined);
  }, periodMs);

  // One sync at launch, so a freshly-opened tab reconciles immediately.
  fire("launch");

  let stopped = false;
  return {
    scheduler,
    syncNow: () => scheduler.request("manual"),
    stop: () => {
      if (stopped) return;
      stopped = true;
      target.removeEventListener("online", onOnline);
      target.removeEventListener("focus", onFocus);
      documentRef.removeEventListener("visibilitychange", onVisibility);
      clearInterval(interval);
    },
  };
}
