/**
 * GENESIS Phase 7: the feedback endpoints sit behind the global JWT guard like every non-@Public route
 * (same pattern as trade-lots.auth.test.ts). Boots a real Nest HTTP app with the production JwtAuthGuard
 * and a stub service (no database). Also checks the limit bounds reach the service and only GET exists.
 */
import "reflect-metadata";
import { Module, UnauthorizedException, type INestApplication } from "@nestjs/common";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FeedbackController } from "./feedback.controller.js";
import { boundedLimit, FEEDBACK_SUMMARY_MAX_LIMIT, FeedbackService, HYPOTHETICAL_MAX_LIMIT } from "./feedback.service.js";
import { JwtAuthGuard } from "./http.js";

const calls: string[] = [];
const stub = {
  summary: async (query: { limit?: string }) => { calls.push(`summary:${query.limit ?? ""}`); return { source: "OBSERVED_FILL" }; },
  hypothetical: async (query: { limit?: string }) => { calls.push(`hypothetical:${query.limit ?? ""}`); return { source: "HYPOTHETICAL" }; },
  lot: async (key: string) => { calls.push(`lot:${key}`); return { lotKey: key }; },
};
const auth = {
  verify: async (token: string) => {
    if (token !== "valid-token") throw new UnauthorizedException("Invalid token");
    return { id: "u1", email: "viewer@odin.local", role: "VIEWER" };
  },
};

// Vitest's transform does not emit decorator metadata; declare the constructor dependency explicitly.
Reflect.defineMetadata("design:paramtypes", [FeedbackService], FeedbackController);

class TestModule {}
Module({
  controllers: [FeedbackController],
  providers: [
    { provide: FeedbackService, useValue: stub },
    { provide: APP_GUARD, useFactory: (reflector: Reflector) => new JwtAuthGuard(reflector, auth as never), inject: [Reflector] },
  ],
})(TestModule);

describe("GENESIS feedback endpoints require authentication", () => {
  let app: INestApplication;
  let base = "";
  const authed = { headers: { authorization: "Bearer valid-token" } };

  beforeAll(async () => {
    app = await NestFactory.create(TestModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  });

  afterAll(async () => {
    await app.close();
  });

  for (const path of ["/api/terminal/feedback/summary", "/api/terminal/feedback/hypothetical", "/api/terminal/feedback/lots/fill_x"]) {
    it(`GET ${path} without a token is 401 and never reaches the service`, async () => {
      const before = calls.length;
      const anonymous = await fetch(base + path);
      expect(anonymous.status).toBe(401);
      const badToken = await fetch(base + path, { headers: { authorization: "Bearer forged" } });
      expect(badToken.status).toBe(401);
      expect(calls.length).toBe(before);
    });
  }

  it("serves authenticated requests and passes the limit through", async () => {
    const summary = await fetch(base + "/api/terminal/feedback/summary?limit=7", authed);
    expect(summary.status).toBe(200);
    expect(await summary.json()).toEqual({ source: "OBSERVED_FILL" });
    expect(calls.at(-1)).toBe("summary:7");
    const hypothetical = await fetch(base + "/api/terminal/feedback/hypothetical", authed);
    expect(await hypothetical.json()).toEqual({ source: "HYPOTHETICAL" });
    expect(calls.at(-1)).toBe("hypothetical:");
    const lot = await fetch(base + "/api/terminal/feedback/lots/fill_x", authed);
    expect(lot.status).toBe(200);
    expect(calls.at(-1)).toBe("lot:fill_x");
  });

  it("is read-only: POST is not routed", async () => {
    const before = calls.length;
    const response = await fetch(base + "/api/terminal/feedback/summary", { method: "POST", ...authed });
    expect(response.status).toBe(404);
    expect(calls.length).toBe(before);
  });

  it("bounds limits to [1, max]", () => {
    expect(boundedLimit(undefined, 100, FEEDBACK_SUMMARY_MAX_LIMIT)).toBe(100);
    expect(boundedLimit("100000", 100, FEEDBACK_SUMMARY_MAX_LIMIT)).toBe(FEEDBACK_SUMMARY_MAX_LIMIT);
    expect(boundedLimit("-5", 25, HYPOTHETICAL_MAX_LIMIT)).toBe(1);
    expect(boundedLimit("abc", 25, HYPOTHETICAL_MAX_LIMIT)).toBe(25);
  });
});
