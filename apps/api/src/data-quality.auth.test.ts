/**
 * GENESIS Phase 3: the data-quality endpoints sit behind the global JWT guard and only read.
 * Boots a real Nest HTTP app with the production JwtAuthGuard and a stub Prisma client (no database).
 */
import "reflect-metadata";
import { Module, UnauthorizedException, type INestApplication } from "@nestjs/common";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import { PrismaClient } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataQualityController } from "./data-quality.controller.js";
import { JwtAuthGuard } from "./http.js";

const calls: string[] = [];
const record = (name: string) => (...args: unknown[]) => {
  calls.push(name);
  void args;
  return Promise.resolve(name.endsWith("findMany") ? [] : null);
};
const prismaStub = {
  historicalDataset: { findMany: record("historicalDataset.findMany"), findUnique: record("historicalDataset.findUnique") },
  // Any write would throw: the stub has no create/update/delete.
};
const auth = {
  verify: async (token: string) => {
    if (token !== "valid-token") throw new UnauthorizedException("Invalid token");
    return { id: "u1", email: "viewer@odin.local", role: "VIEWER" };
  },
};

Reflect.defineMetadata("design:paramtypes", [PrismaClient], DataQualityController);

class TestModule {}
Module({
  controllers: [DataQualityController],
  providers: [
    { provide: PrismaClient, useValue: prismaStub },
    { provide: APP_GUARD, useFactory: (reflector: Reflector) => new JwtAuthGuard(reflector, auth as never), inject: [Reflector] },
  ],
})(TestModule);

describe("GENESIS data-quality endpoints", () => {
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

  for (const path of ["/api/research/data-quality", "/api/research/data-quality/ds_1"]) {
    it(`GET ${path} without a valid token is 401 and never reaches the database`, async () => {
      const before = calls.length;
      expect((await fetch(base + path)).status).toBe(401);
      expect((await fetch(base + path, { headers: { authorization: "Bearer forged" } })).status).toBe(401);
      expect(calls.length).toBe(before);
    });
  }

  it("serves an authenticated list with the survivorship disclosure", async () => {
    const response = await fetch(base + "/api/research/data-quality", { headers: { authorization: "Bearer valid-token" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ datasets: [], survivorship: { datasets: 0, byCohort: {}, inactiveCohort: 0, possiblyInactive: 0, status: "EMPTY" } });
  });

  it("404s an unknown dataset and 400s malformed input", async () => {
    const headers = { authorization: "Bearer valid-token" };
    expect((await fetch(base + "/api/research/data-quality/ds_missing", { headers })).status).toBe(404);
    expect((await fetch(base + "/api/research/data-quality/ds_1?from=2026-01-01T00:00:00Z", { headers })).status).toBe(400);
    expect((await fetch(base + "/api/research/data-quality/ds_1?from=nope&to=2026-01-01T00:00:00Z", { headers })).status).toBe(400);
  });

  it("does not accept writes", async () => {
    const response = await fetch(base + "/api/research/data-quality", { method: "POST", headers: { authorization: "Bearer valid-token" } });
    expect(response.status).toBe(404);
  });
});
