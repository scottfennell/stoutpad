import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ConflictNotification } from "@stout/core";
import {
  ConflictToasts,
  useConflictNotifications,
  type ConflictNotifications,
} from "./conflict-toast.js";

afterEach(cleanup);

const SAMPLE: ConflictNotification = {
  notePath: "notes/log",
  noteTitle: "Daily Log",
  copyPath: "notes/daily-log-conflict-copy-20260616-130509",
  copyTitle: "Daily Log (conflict copy 20260616-130509)",
  message:
    '"Daily Log" had a conflicting edit — your version was saved as "Daily Log (conflict copy 20260616-130509)".',
};

/** A harness exposing the hook through buttons, so the controller wiring is realistic. */
function Harness({ onOpenCopy }: { onOpenCopy: (path: string) => void }) {
  let handle!: ConflictNotifications;
  function Inner() {
    handle = useConflictNotifications();
    return (
      <>
        <button data-testid="fire" onClick={() => handle.notify(SAMPLE)}>
          fire
        </button>
        <ConflictToasts
          toasts={handle.toasts}
          onOpenCopy={onOpenCopy}
          onDismiss={handle.dismiss}
        />
      </>
    );
  }
  return <Inner />;
}

describe("ConflictToasts + useConflictNotifications", () => {
  it("renders nothing until a conflict is notified", () => {
    render(<Harness onOpenCopy={() => undefined} />);
    expect(screen.queryByTestId("conflict-toasts")).toBeNull();
  });

  it("surfaces a notified conflict as a non-blocking toast in a polite live region", () => {
    render(<Harness onOpenCopy={() => undefined} />);
    fireEvent.click(screen.getByTestId("fire"));

    const region = screen.getByTestId("conflict-toasts");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByTestId("conflict-toast").textContent).toContain(
      "had a conflicting edit",
    );
  });

  it("navigates to the conflict copy when 'Open copy' is clicked", () => {
    const onOpenCopy = vi.fn();
    render(<Harness onOpenCopy={onOpenCopy} />);
    fireEvent.click(screen.getByTestId("fire"));
    fireEvent.click(screen.getByTestId("conflict-open-copy"));

    expect(onOpenCopy).toHaveBeenCalledWith(SAMPLE.copyPath);
  });

  it("dismisses a toast without affecting the others", () => {
    render(<Harness onOpenCopy={() => undefined} />);
    fireEvent.click(screen.getByTestId("fire"));
    fireEvent.click(screen.getByTestId("fire"));
    expect(screen.getAllByTestId("conflict-toast")).toHaveLength(2);

    fireEvent.click(screen.getAllByTestId("conflict-dismiss")[0]);
    expect(screen.getAllByTestId("conflict-toast")).toHaveLength(1);
  });
});
