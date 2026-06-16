/**
 * Non-blocking conflict notifications (toasts).
 *
 * When a multi-device sync produces a true conflict, the core
 * {@link ConflictNotification} reports that the incoming `main` version was kept
 * on the note and the local version was preserved as a sibling conflict copy.
 * This module surfaces that to the user **without interrupting them**: a small
 * stack of dismissible toasts in a polite live region — never a modal, never a
 * blocked editor — each offering a one-click jump to the saved copy.
 *
 * The {@link useConflictNotifications} hook owns the toast list (assigning stable
 * ids); {@link ConflictToasts} is a pure presentational render of it. The sync
 * controller calls `notify(...)` with each notification it gets back from
 * {@link applyConflictResolution}.
 *
 * See `docs/adr/0011-pwa-offline-and-conflict-policy.md`.
 */

import { useCallback, useRef, useState } from "react";
import type { ConflictNotification } from "@stout/core";

/** A conflict notification plus the stable id used as its React key. */
export interface ConflictToast {
  /** Stable, monotonically-assigned id (also the dismissal handle). */
  id: number;
  /** The core notification this toast renders. */
  notification: ConflictNotification;
}

/** The toast list plus the imperative handles to add and remove entries. */
export interface ConflictNotifications {
  /** The current toasts, in arrival order. */
  toasts: ConflictToast[];
  /** Add a toast for a conflict notification. */
  notify: (notification: ConflictNotification) => void;
  /** Remove the toast with `id` (user dismissal). */
  dismiss: (id: number) => void;
}

/**
 * Own the conflict-toast list: append on {@link ConflictNotifications.notify},
 * remove on {@link ConflictNotifications.dismiss}. Ids are assigned from a ref so
 * they stay stable and unique across renders.
 */
export function useConflictNotifications(): ConflictNotifications {
  const [toasts, setToasts] = useState<ConflictToast[]>([]);
  const nextId = useRef(0);

  const notify = useCallback((notification: ConflictNotification) => {
    setToasts((prev) => [...prev, { id: nextId.current++, notification }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  return { toasts, notify, dismiss };
}

/**
 * Render the conflict toasts as a non-blocking, dismissible stack in a polite
 * live region. Each toast states what happened and offers "Open copy" (navigates
 * to the conflict-copy note) and "Dismiss". Renders nothing when the list is
 * empty.
 */
export function ConflictToasts({
  toasts,
  onOpenCopy,
  onDismiss,
}: {
  toasts: ConflictToast[];
  onOpenCopy: (path: string) => void;
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      className="conflict-toasts"
      role="status"
      aria-live="polite"
      data-testid="conflict-toasts"
    >
      {toasts.map(({ id, notification }) => (
        <div key={id} className="conflict-toast" data-testid="conflict-toast">
          <p className="conflict-toast__message">{notification.message}</p>
          <div className="conflict-toast__actions">
            <button
              type="button"
              className="conflict-toast__action"
              data-testid="conflict-open-copy"
              onClick={() => onOpenCopy(notification.copyPath)}
            >
              Open copy
            </button>
            <button
              type="button"
              className="conflict-toast__dismiss"
              aria-label="Dismiss notification"
              data-testid="conflict-dismiss"
              onClick={() => onDismiss(id)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
