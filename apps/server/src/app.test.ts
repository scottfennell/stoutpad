import { describe, expect, it } from "vitest";
import request from "supertest";
import { HEALTH_PATH, type HealthStatus } from "@stout/core";
import { createApp } from "./app.js";

const okHealth: HealthStatus = {
  status: "ok",
  service: "stout",
  database: true,
  migration: 1,
  timestamp: new Date().toISOString(),
};

describe("health round-trip", () => {
  it("returns the health status as JSON with 200", async () => {
    const app = createApp({ getHealth: async () => okHealth });

    const res = await request(app).get(HEALTH_PATH);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      service: "stout",
      database: true,
      migration: 1,
    });
  });

  it("returns 503 when the service is degraded", async () => {
    const app = createApp({
      getHealth: async () => ({ ...okHealth, status: "degraded", database: false }),
    });

    const res = await request(app).get(HEALTH_PATH);

    expect(res.status).toBe(503);
    expect(res.body.database).toBe(false);
  });

  it("returns 503 when the health check throws", async () => {
    const app = createApp({
      getHealth: async () => {
        throw new Error("db down");
      },
    });

    const res = await request(app).get(HEALTH_PATH);

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
  });
});
