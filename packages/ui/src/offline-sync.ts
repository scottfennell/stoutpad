/**
 * The offline runtime's {@link SyncRunner}: what a cadence trigger actually does.
 *
 * `core/sync-cadence` (and its `sync-cadence-controller.ts` DOM wiring) decide
 * **when** to sync — launch / reconnect / focus / timer / manual — and call an
 * injected {@link SyncRunner} to do the work. This module builds that runner for
 * the PWA: it reconciles the local IndexedDB clone with a remote and surfaces any
 * {@link ConflictNotification}s (from `core/conflict`'s keep-both policy) through
 * a sink — the same sink the App wires to its non-blocking conflict toasts.
 *
 * A **purely local** PWA (no hub configured) has nothing to reconcile, so
 * `reconcile` is omitted and the runner is a well-behaved no-op that still
 * completes — the cadence controller records the run, proving the wiring is live
 * without any network. When hub sync lands, its reconcile is injected here and
 * its conflict copies flow to the toasts unchanged. Pure but for the injected
 * callbacks, so it is unit tested with a fake reconcile.
 *
 * See `docs/adr/0011-pwa-offline-and-conflict-policy.md`.
 */

import type { ConflictNotification, SyncRunner, SyncTrigger } from "@stout/core";

/** Options for {@link createOfflineSyncRunner}. */
export interface OfflineSyncRunnerOptions {
  /**
   * Reconcile the local clone with the remote for a trigger, returning any
   * conflict notifications the merge produced (empty when it merged cleanly).
   * Omitted for a local-only PWA, which makes the runner a no-op.
   */
  reconcile?: (trigger: SyncTrigger) => Promise<ConflictNotification[]>;
  /** Sink for each conflict notification (wired to the App's conflict toasts). */
  notify?: (notification: ConflictNotification) => void;
  /**
   * Called after a reconcile completes, so the UI can refetch the tree/note a
   * pull may have changed. Not called when `reconcile` is omitted.
   */
  onChanged?: () => void;
}

/**
 * Create the {@link SyncRunner} the cadence controller drives. Each run
 * reconciles (when a `reconcile` is configured), forwards every conflict
 * notification to `notify`, and signals `onChanged` so the UI can refresh.
 */
export function createOfflineSyncRunner(
  options: OfflineSyncRunnerOptions = {},
): SyncRunner {
  const { reconcile, notify, onChanged } = options;
  return async (trigger: SyncTrigger): Promise<void> => {
    if (reconcile === undefined) return; // local-only: nothing to reconcile
    const notifications = await reconcile(trigger);
    for (const notification of notifications) notify?.(notification);
    onChanged?.();
  };
}
