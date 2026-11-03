/**
 * ASCEND-09: the lot endpoints sit behind the global JWT guard like every non-@Public route.
 * Boots a real Nest HTTP app with the production JwtAuthGuard and a stub service (no database).
 */
import "reflect-metadata";
import { Module, UnauthorizedException, type INestApplication } from "@nestjs/common";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JwtAuthGuard } from "./http.js";
import { TradeLotsController } from "./trade-lots.controller.js";
import { TradeLotsService } from "./trade-lots.service.js";

const calls: string[] = [];
const stub = {
  listLots: async () => { calls.push("list"); return { lots: [] }; },
  attribution: async () => { calls.push("attribution"); return { status: "PNL_FEES_RECONCILED" }; },
  lotTimeline: async (key: string) => { calls.push(`timeline:${key}`); return { lot: key }; },
};
const auth = {
  verify: async (token: string) => {
    if (token !== "valid-token") throw new UnauthorizedException("Invalid token");
    return { id: "u1", email: "viewer@odin.local", role: "VIEWER" };
  },
};

// Vitest's transform does not emit decorator metadata; declare the constructor dependency explicitly.
Reflect.defineMetadata("design:paramtypes", [TradeLotsService], TradeLotsController);

class TestModule {}
Module({
  controllers: [TradeLotsController],
  providers: [
    { provide: TradeLotsService, useValue: stub },
    { provide: APP_GUARD, useFactory: (reflector: Reflector) => new JwtAuthGuard(reflector, auth as never), inject: [Reflector] },
  ],
})(TestModule);

describe("ASCEND-09 lot endpoints require authentication", () => {
  let app: INestApplication;
  let base = "";

  beforeAll(async () => {
    app = await NestFactory.create(TestModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  });

  afterAll(async () => {
    await app.close();
  });

  for (const path of ["/api/terminal/lots", "/api/terminal/lots/attribution", "/api/terminal/lots/fill_x"]) {
    it(`GET ${path} without a token is 401 and never reaches the service`, async () => {
      const before = calls.length;
      const anonymous = await fetch(base + path);
      expect(anonymous.status).toBe(401);
      const badToken = await fetch(base + path, { headers: { authorization: "Bearer forged" } });
      expect(badToken.status).toBe(401);
      expect(calls.length).toBe(before);
    });
  }

  it("serves an authenticated request (attribution is not captured as a lot key)", async () => {
    const response = await fetch(base + "/api/terminal/lots/attribution", { headers: { authorization: "Bearer valid-token" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "PNL_FEES_RECONCILED" });
    expect(calls.at(-1)).toBe("attribution");
    const timeline = await fetch(base + "/api/terminal/lots/fill_x", { headers: { authorization: "Bearer valid-token" } });
    expect(timeline.status).toBe(200);
    expect(calls.at(-1)).toBe("timeline:fill_x");
  });
});
