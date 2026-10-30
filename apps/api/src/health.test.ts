import { describe, expect, it, vi } from "vitest";

const constructed: unknown[] = [];
vi.mock("ioredis", () => ({
  default: class FakeRedis {
    constructor(...args: unknown[]) {
      constructed.push(args);
    }
    on() {
      return this;
    }
    async ping() {
      return "PONG";
    }
    disconnect() {
      return undefined;
    }
  },
}));

const { RedisHealth } = await import("./redis-health.js");
const { TerminalController } = await import("./terminal.controller.js");

const detail = {
  status: "ok",
  postgres: "up",
  redis: "up",
  engine: "RUNNING",
  dataState: "LIVE",
  lastObservationAt: "2026-10-30T00:00:00.000Z",
  lastCycleAt: null,
  lastCycleStatus: null,
  venue: "PAPER",
};

describe("health endpoints (audit M9)", () => {
  it("reuses one Redis client across health checks", async () => {
    constructed.length = 0;
    const health = new RedisHealth("redis://127.0.0.1:6379");
    expect(await health.ping()).toBe(true);
    expect(await health.ping()).toBe(true);
    expect(await health.ping()).toBe(true);
    expect(constructed).toHaveLength(1);
  });

  it("reports down without a Redis URL instead of throwing", async () => {
    expect(await new RedisHealth(undefined).ping()).toBe(false);
  });

  it("public /health and /ready return status only; detail needs auth", async () => {
    const terminal = { health: vi.fn(async (ping: () => Promise<boolean>) => ({ ...detail, redis: (await ping()) ? "up" : "down" })) };
    const controller = new TerminalController(terminal as never, new RedisHealth("redis://127.0.0.1:6379"));
    expect(await controller.health()).toEqual({ status: "ok" });
    const response = { status: vi.fn() };
    expect(await controller.ready(response as never)).toEqual({ status: "ok" });
    expect(response.status).not.toHaveBeenCalled();
    expect(await controller.healthDetail()).toMatchObject({ postgres: "up", redis: "up", engine: "RUNNING" });
  });

  it("ready returns 503 with status only when degraded", async () => {
    const terminal = { health: vi.fn(async () => ({ ...detail, status: "degraded", redis: "down" })) };
    const controller = new TerminalController(terminal as never, new RedisHealth("redis://127.0.0.1:6379"));
    const response = { status: vi.fn() };
    expect(await controller.ready(response as never)).toEqual({ status: "degraded" });
    expect(response.status).toHaveBeenCalledWith(503);
  });

  it("marks health/detail as authenticated (no @Public)", async () => {
    const { Reflector } = await import("@nestjs/core");
    const { IS_PUBLIC } = await import("./http.js");
    const reflector = new Reflector();
    expect(reflector.get(IS_PUBLIC, TerminalController.prototype.health)).toBe(true);
    expect(reflector.get(IS_PUBLIC, TerminalController.prototype.healthDetail)).toBeUndefined();
  });
});
