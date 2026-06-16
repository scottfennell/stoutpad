/**
 * `core/sync-cadence` — the pure sync **scheduler** (when to sync).
 *
 * Where `core/sync` owns a single note's autosave/squash session, this module
 * owns the *cadence* of syncing the whole workspace with the hub/`main`: it
 * decides **when** a sync runs in response to the five triggers the multi-device
 * story calls for — app **launch**, network **reconnect**, window **focus**, a
 * periodic **timer**, and a **manual** request — while keeping the actual sync
 * work behind an injected {@link SyncRunner} (real Git/HTTP in the app, a fake in
 * tests). It is a pure, runtime-agnostic state machine driven by an injected
 * {@link SyncClock}; it owns no real timers (the host calls {@link SyncScheduler.tick}).
 *
 * Two guarantees make the cadence well-behaved:
 * - **Single-flight.** Only one sync runs at a time. A trigger that arrives while
 *   a sync is in flight is **coalesced** into a single pending follow-up that runs
 *   once the current sync finishes (so a burst of focus events never stacks up).
 * - **Throttle.** Frequent, low-value triggers (`focus`) are throttled to at most
 *   one per `minIntervalMs`. The forced triggers — `launch`, `reconnect`,
 *   `manual`, and the self-gated `timer` — always run.
 *
 * The DOM wiring that maps `online`/`focus`/`visibilitychange`/`setInterval` to
 * these requests lives in `@stout/ui` (`sync-cadence-controller.ts`), so the
 * decision logic here stays pure and unit-tested.
 *
 * See `docs/adr/0011-pwa-offline-and-conflict-policy.md`.
 */

import type { SyncClock } from "./sync.js";

/** What caused a sync to be requested. */
export type SyncTrigger = "launch" | "reconnect" | "focus" | "timer" | "manual";

/** A completed sync attempt (for the UI and for test assertions). */
export interface SyncRun {
  /** The trigger that caused this run (the highest-priority of any coalesced). */
  trigger: SyncTrigger;
  /** Clock time the run started. */
  startedAt: number;
  /** Clock time the run finished. */
  finishedAt: number;
  /** Whether the runner resolved (`true`) or threw (`false`). */
  ok: boolean;
  /** The error message when the runner threw. */
  error?: string;
}

/** What {@link SyncScheduler.request} decided to do with a trigger. */
export type RequestOutcome =
  /** A sync ran (and any coalesced follow-ups ran) to completion. */
  | "ran"
  /** A sync was already in flight; this trigger was coalesced into a follow-up. */
  | "coalesced"
  /** A throttled trigger arrived too soon after the last run and was dropped. */
  | "throttled";

/** Performs an actual sync for a trigger. Injected; the only IO the scheduler does. */
export type SyncRunner = (trigger: SyncTrigger) => Promise<void>;

/** Construction options for a {@link SyncScheduler}. */
export interface SyncSchedulerOptions {
  /** Minimum ms between throttled (`focus`) syncs. Default {@link DEFAULT_MIN_SYNC_INTERVAL_MS}. */
  minIntervalMs?: number;
  /** Period of the {@link SyncScheduler.tick} timer trigger. Default {@link DEFAULT_SYNC_PERIOD_MS}. */
  periodMs?: number;
  /** Injected clock; defaults to wall-clock time. */
  clock?: SyncClock;
}

/** Default minimum interval between throttled (`focus`) syncs: 5s. */
export const DEFAULT_MIN_SYNC_INTERVAL_MS = 5000 as const;

/** Default period of the timer trigger: 60s. */
export const DEFAULT_SYNC_PERIOD_MS = 60000 as const;

const systemClock: SyncClock = { now: () => Date.now() };

/** Triggers that always run, never throttled. */
const FORCED: ReadonlySet<SyncTrigger> = new Set<SyncTrigger>([
  "launch",
  "reconnect",
  "manual",
  "timer",
]);

/** Priority for choosing a single label when triggers are coalesced (higher wins). */
const PRIORITY: Record<SyncTrigger, number> = {
  manual: 5,
  reconnect: 4,
  launch: 3,
  timer: 2,
  focus: 1,
};

/** The higher-priority of two triggers (used when coalescing). */
function strongerTrigger(a: SyncTrigger | null, b: SyncTrigger): SyncTrigger {
  if (a === null) return b;
  return PRIORITY[b] >= PRIORITY[a] ? b : a;
}

/**
 * The pure sync scheduler. Construct it with a {@link SyncRunner}, drive it with
 * {@link request} (launch/reconnect/focus/manual) and {@link tick} (the periodic
 * timer), and read completed attempts off {@link runs}.
 */
export class SyncScheduler {
  private readonly runner: SyncRunner;
  private readonly minIntervalMs: number;
  private readonly periodMs: number;
  private readonly clock: SyncClock;

  /** Whether a sync is currently in flight (single-flight guard). */
  private running = false;
  /** The highest-priority trigger queued while a sync was in flight, if any. */
  private pending: SyncTrigger | null = null;
  /** Clock time the most recent run started (throttle reference); `null` if none. */
  private lastRunAt: number | null = null;
  /** Clock time the timer last fired (period reference). */
  private lastTimerAt: number | null = null;

  /** Completed sync attempts, in order. */
  readonly runs: SyncRun[] = [];

  constructor(runner: SyncRunner, options: SyncSchedulerOptions = {}) {
    this.runner = runner;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_SYNC_INTERVAL_MS;
    this.periodMs = options.periodMs ?? DEFAULT_SYNC_PERIOD_MS;
    this.clock = options.clock ?? systemClock;
  }

  /** Whether a sync is currently in flight. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Request a sync for `trigger`.
   *
   * A throttled (`focus`) trigger that arrives within `minIntervalMs` of the last
   * run is dropped (`"throttled"`). If a sync is in flight, the trigger is
   * coalesced into a single pending follow-up (`"coalesced"`). Otherwise the sync
   * runs now (and drains any follow-ups) and resolves `"ran"`.
   */
  async request(trigger: SyncTrigger): Promise<RequestOutcome> {
    if (!FORCED.has(trigger) && this.isThrottled()) return "throttled";
    if (this.running) {
      this.pending = strongerTrigger(this.pending, trigger);
      return "coalesced";
    }
    await this.drain(trigger);
    return "ran";
  }

  /**
   * Advance the timer. When at least `periodMs` has elapsed since the last timer
   * fire (always, on the first call), request a `timer` sync. `nowMs` defaults to
   * the injected clock so tests can drive the period explicitly.
   */
  async tick(nowMs: number = this.clock.now()): Promise<void> {
    if (this.lastTimerAt !== null && nowMs - this.lastTimerAt < this.periodMs) return;
    this.lastTimerAt = nowMs;
    await this.request("timer");
  }

  /** Whether a throttled trigger should be dropped right now. */
  private isThrottled(): boolean {
    if (this.lastRunAt === null) return false;
    return this.clock.now() - this.lastRunAt < this.minIntervalMs;
  }

  /** Run `trigger`, then drain any follow-up coalesced while it ran. */
  private async drain(trigger: SyncTrigger): Promise<void> {
    this.running = true;
    let current: SyncTrigger | null = trigger;
    try {
      while (current !== null) {
        await this.runOnce(current);
        current = this.pending;
        this.pending = null;
      }
    } finally {
      this.running = false;
    }
  }

  /** Execute the runner once, recording the attempt (success or failure). */
  private async runOnce(trigger: SyncTrigger): Promise<void> {
    const startedAt = this.clock.now();
    this.lastRunAt = startedAt;
    try {
      await this.runner(trigger);
      this.runs.push({ trigger, startedAt, finishedAt: this.clock.now(), ok: true });
    } catch (err) {
      this.runs.push({
        trigger,
        startedAt,
        finishedAt: this.clock.now(),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
