import { describe, expect, it } from "vitest";
import {
  slugifyAttachmentName,
  writeAttachment,
  type AttachmentGitEngine,
} from "./attachment.js";

/**
 * In-memory {@link AttachmentGitEngine}: a path→bytes map that reproduces the
 * Node impl's collision rule — a taken path gets a `-1`, `-2`, … suffix before
 * the extension — so {@link writeAttachment}'s composition is tested without Git.
 */
class InMemoryAttachmentEngine implements AttachmentGitEngine {
  readonly files = new Map<string, Uint8Array>();
  readonly messages: string[] = [];

  async writeAttachmentFile(
    desiredPath: string,
    bytes: Uint8Array,
    message: string,
  ): Promise<string> {
    this.messages.push(message);
    const path = this.uniquePath(desiredPath);
    this.files.set(path, bytes);
    return path;
  }

  private uniquePath(desiredPath: string): string {
    if (!this.files.has(desiredPath)) return desiredPath;
    const dot = desiredPath.lastIndexOf(".");
    const stem = dot === -1 ? desiredPath : desiredPath.slice(0, dot);
    const ext = dot === -1 ? "" : desiredPath.slice(dot);
    for (let n = 1; ; n += 1) {
      const candidate = `${stem}-${n}${ext}`;
      if (!this.files.has(candidate)) return candidate;
    }
  }
}

describe("slugifyAttachmentName", () => {
  it("kebab-cases the base name and lowercases the extension", () => {
    expect(slugifyAttachmentName("My Diagram.PNG")).toBe("my-diagram.png");
  });

  it("collapses punctuation runs and trims dashes", () => {
    expect(slugifyAttachmentName("a  b__c!!.jpeg")).toBe("a-b-c.jpeg");
  });

  it("falls back to `file` when the base has no usable characters", () => {
    expect(slugifyAttachmentName("???.jpg")).toBe("file.jpg");
  });

  it("keeps a bare name with no extension", () => {
    expect(slugifyAttachmentName("screenshot")).toBe("screenshot");
  });
});

describe("writeAttachment", () => {
  it("stores the bytes under assets/<slug> and returns the path", async () => {
    const engine = new InMemoryAttachmentEngine();
    const bytes = new Uint8Array([1, 2, 3]);

    const result = await writeAttachment(engine, "My Diagram.png", bytes);

    expect(result).toEqual({ path: "assets/my-diagram.png" });
    expect(engine.files.get("assets/my-diagram.png")).toBe(bytes);
    expect(engine.messages).toEqual(["Add attachment assets/my-diagram.png"]);
  });

  it("lets the engine resolve a collision to a unique path", async () => {
    const engine = new InMemoryAttachmentEngine();

    const first = await writeAttachment(engine, "logo.png", new Uint8Array([0]));
    const second = await writeAttachment(engine, "logo.png", new Uint8Array([1]));

    expect(first.path).toBe("assets/logo.png");
    expect(second.path).toBe("assets/logo-1.png");
    expect([...engine.files.keys()]).toEqual([
      "assets/logo.png",
      "assets/logo-1.png",
    ]);
  });
});
