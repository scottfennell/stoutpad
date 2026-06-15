import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { TipTapEditor } from "./TipTapEditor.js";

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
