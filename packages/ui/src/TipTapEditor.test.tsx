import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TipTapEditor, WikiLinkSuggestions } from "./TipTapEditor.js";
import type { WikiLinkContext } from "./editor.js";

afterEach(cleanup);

const NOTE = `# Project Plan

Ship the **walking** skeleton.

- [x] Init repo
- [ ] Write docs
`;

describe("TipTapEditor", () => {
  it("renders a representative note with formatting and checkboxes live", async () => {
    render(<TipTapEditor markdown={NOTE} />);

    // Heading and prose render as rich text.
    await waitFor(() => expect(screen.getByText("Project Plan")).toBeTruthy());
    expect(screen.getByText("walking").tagName.toLowerCase()).toBe("strong");

    // The task list renders one checkbox per item, reflecting checked state.
    const checkboxes = await waitFor(() => {
      const found = document.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]',
      );
      expect(found.length).toBe(2);
      return found;
    });
    expect(checkboxes[0].checked).toBe(true);
    expect(checkboxes[1].checked).toBe(false);
  });
});

/** A wikilink context where only "Home" resolves; everything else is broken. */
function homeOnlyContext(overrides: Partial<WikiLinkContext> = {}): WikiLinkContext {
  return {
    titles: ["Home", "Notes"],
    resolve: (target) => (target === "Home" ? "home" : null),
    ...overrides,
  };
}

describe("TipTapEditor wikilinks", () => {
  it("styles resolved and broken [[links]] distinctly", async () => {
    render(
      <TipTapEditor
        markdown="See [[Home]] and [[Ghost]] today"
        wikiLinks={homeOnlyContext()}
      />,
    );

    const links = await waitFor(() => {
      const found = document.querySelectorAll<HTMLElement>(".wikilink");
      expect(found.length).toBe(2);
      return found;
    });

    // The resolved link carries the target's note path; the broken one does not
    // and is additionally flagged with the `wikilink-broken` class.
    const resolved = [...links].find(
      (el) => el.getAttribute("data-wikilink-target") === "Home",
    );
    const broken = [...links].find(
      (el) => el.getAttribute("data-wikilink-target") === "Ghost",
    );
    expect(resolved?.getAttribute("data-wikilink-path")).toBe("home");
    expect(resolved?.classList.contains("wikilink-broken")).toBe(false);
    expect(broken?.getAttribute("data-wikilink-path")).toBeNull();
    expect(broken?.classList.contains("wikilink-broken")).toBe(true);
  });

  it("navigates when a resolved link is clicked, but not a broken one", async () => {
    const onNavigate = vi.fn();
    render(
      <TipTapEditor
        markdown="See [[Home]] and [[Ghost]]"
        wikiLinks={homeOnlyContext({ onNavigate })}
      />,
    );

    const links = await waitFor(() => {
      const found = document.querySelectorAll<HTMLElement>(".wikilink");
      expect(found.length).toBe(2);
      return found;
    });
    const resolved = [...links].find(
      (el) => el.getAttribute("data-wikilink-target") === "Home",
    )!;
    const broken = [...links].find(
      (el) => el.getAttribute("data-wikilink-target") === "Ghost",
    )!;

    fireEvent.click(broken);
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.click(resolved);
    expect(onNavigate).toHaveBeenCalledWith("home", "Home");
  });
});

describe("WikiLinkSuggestions", () => {
  it("renders the ranked titles as a listbox marking the active option", () => {
    render(
      <WikiLinkSuggestions
        items={["Home", "Notes"]}
        activeIndex={1}
        onPick={() => undefined}
      />,
    );

    const options = screen.getAllByRole("option");
    expect(options.map((el) => el.textContent)).toEqual(["Home", "Notes"]);
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    expect(options[0].getAttribute("aria-selected")).toBe("false");
  });

  it("picks the title under the pointer (on mousedown, before blur)", () => {
    const onPick = vi.fn();
    render(
      <WikiLinkSuggestions items={["Home", "Notes"]} activeIndex={0} onPick={onPick} />,
    );

    fireEvent.mouseDown(screen.getByRole("button", { name: "Notes" }));
    expect(onPick).toHaveBeenCalledWith("Notes");
  });
});
