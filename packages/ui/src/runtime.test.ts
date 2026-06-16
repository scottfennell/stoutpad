import { describe, expect, it } from "vitest";
import { resolveRuntimeMode } from "./runtime.js";

describe("resolveRuntimeMode", () => {
  it("selects the offline runtime only for an explicit ?runtime=offline", () => {
    expect(resolveRuntimeMode("?runtime=offline")).toBe("offline");
    expect(resolveRuntimeMode("?foo=bar&runtime=offline")).toBe("offline");
    expect(resolveRuntimeMode("runtime=offline")).toBe("offline");
  });

  it("defaults to the server runtime for an empty or unrelated query", () => {
    expect(resolveRuntimeMode("")).toBe("server");
    expect(resolveRuntimeMode("?foo=bar")).toBe("server");
  });

  it("does not switch on any other runtime value", () => {
    expect(resolveRuntimeMode("?runtime=server")).toBe("server");
    expect(resolveRuntimeMode("?runtime=OFFLINE")).toBe("server");
    expect(resolveRuntimeMode("?runtime=")).toBe("server");
  });
});
