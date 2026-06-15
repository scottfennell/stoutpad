import { describe, expect, it } from "vitest";
import { HEALTH_PATH, type HealthStatus } from "./index.js";

describe("core contracts", () => {
  it("exposes the health path", () => {
    expect(HEALTH_PATH).toBe("/api/health");
  });

  it("describes a well-formed health status", () => {
    const status: HealthStatus = {
      status: "ok",
      service: "stout",
      database: true,
      migration: 0,
      timestamp: new Date().toISOString(),
    };
    expect(status.service).toBe("stout");
  });
});
