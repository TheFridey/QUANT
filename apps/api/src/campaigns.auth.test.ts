/**
 * OPERATION EVIDENCE: the campaign endpoints sit behind the global JWT guard, the reads are bounded and
 * write nothing, and the two writes are ADMIN-only. Boots a real Nest HTTP app with the production guards and
 * a stub Prisma client that records every call.
 */
import "reflect-metadata";
import { Module, UnauthorizedException, type INestApplication } from "@nestjs/common";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import { VIEW_BOUNDS } from "@odin/evolution/campaign";
import { PrismaClient } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CampaignsController } from "./campaigns.controller.js";
import { JwtAuthGuard } from "./http.js";

type Call = { name: string; args: Record<string, unknown> | undefined };
const calls: Call[] = [];
const stub = (name: string, value: unknown) => (args?: Record<string, unknown>) => {
  calls.push({ name, args });
  return Promise.resolve(value);
};
const prismaStub = {
  researchCampaign: { findMany: stub("researchCampaign.findMany", []) },
  researchCampaignRun: { findUnique: stub("researchCampaignRun.findUnique", null), findMany: stub("researchCampaignRun.findMany", []) },
  researchCampaignUnit: { findUnique: stub("researchCampaignUnit.findUnique", null), findMany: stub("researchCampaignUnit.findMany", []), groupBy: stub("researchCampaignUnit.groupBy", []) },
  researchCampaignResult: { findMany: stub("researchCampaignResult.findMany", []) },
  researchCampaignRunState: { findUnique: stub("researchCampaignRunState.findUnique", null) },
  researchTrial: { count: stub("researchTrial.count", 0) },
  $queryRaw: () => {
    calls.push({ name: "$queryRaw", args: undefined });
    return Promise.resolve([{ legacy: 0n, settled: 0n, outstanding: 0n }]);
  },
};
const auth = {
  verify: async (token: string) => {
    if (token === "viewer-token") return { id: "u1", email: "viewer@odin.local", role: "VIEWER" };
    if (token === "admin-token") return { id: "u2", email: "operator@odin.local", role: "ADMIN" };
    throw new UnauthorizedException("Invalid token");
  },
};

Reflect.defineMetadata("design:paramtypes", [PrismaClient], CampaignsController);

class TestModule {}
Module({
  controllers: [CampaignsController],
  providers: [
    { provide: PrismaClient, useValue: prismaStub },
    { provide: APP_GUARD, useFactory: (reflector: Reflector) => new JwtAuthGuard(reflector, auth as never), inject: [Reflector] },
  ],
})(TestModule);

describe("EVIDENCE campaign endpoints", () => {
  let app: INestApplication;
  let base = "";
  const viewer = { authorization: "Bearer viewer-token" };
  const admin = { authorization: "Bearer admin-token", "content-type": "application/json" };
  const RUN = "/api/research/campaigns/runs/cmrun0000000000000000001";
  const UNIT = "/api/research/campaigns/units/cmunit000000000000000001";

  beforeAll(async () => {
    app = await NestFactory.create(TestModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  for (const [method, path] of [["GET", "/api/research/campaigns"], ["GET", RUN], ["GET", `${UNIT}/trials`], ["POST", `${UNIT}/authorize-holdout`], ["POST", `${RUN}/cancel`]] as const) {
    it(`${method} ${path} without a valid token is 401 and never reaches the database`, async () => {
      const before = calls.length;
      expect((await fetch(base + path, { method })).status).toBe(401);
      expect((await fetch(base + path, { method, headers: { authorization: "Bearer forged" } })).status).toBe(401);
      expect(calls.length).toBe(before);
    });
  }

  it("lists campaigns with a bounded read and the programme trial count, writing nothing", async () => {
    calls.length = 0;
    const response = await fetch(base + "/api/research/campaigns", { headers: viewer });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { campaigns: unknown[]; programmeTrials: { total: number }; bounds: typeof VIEW_BOUNDS };
    expect(body.campaigns).toEqual([]);
    expect(body.programmeTrials.total).toBe(0);
    const list = calls.find((c) => c.name === "researchCampaign.findMany")!;
    expect(list.args!.take).toBe(VIEW_BOUNDS.campaigns);
    expect(calls.every((c) => /\.(findMany|findFirst|findUnique|count|groupBy)$|^\$queryRaw$/.test(c.name))).toBe(true);
  });

  it("404s an unknown run or unit and 400s a malformed id before any query", async () => {
    expect((await fetch(base + RUN, { headers: viewer })).status).toBe(404);
    expect((await fetch(base + `${UNIT}/trials`, { headers: viewer })).status).toBe(404);
    const before = calls.length;
    expect((await fetch(base + "/api/research/campaigns/runs/" + encodeURIComponent("1; DROP TABLE"), { headers: viewer })).status).toBe(400);
    expect((await fetch(base + "/api/research/campaigns/units/UPPER-case/trials", { headers: viewer })).status).toBe(400);
    expect(calls.length).toBe(before);
  });

  it("a non-admin cannot authorise a holdout or cancel a run, and nothing is read or written for them", async () => {
    const before = calls.length;
    expect((await fetch(base + `${UNIT}/authorize-holdout`, { method: "POST", headers: { ...viewer, "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await fetch(base + `${RUN}/cancel`, { method: "POST", headers: viewer })).status).toBe(403);
    expect(calls.length).toBe(before);
  });

  it("an admin authorising an unknown unit gets 404, bad input 400; no route evaluates a holdout", async () => {
    expect((await fetch(base + `${UNIT}/authorize-holdout`, { method: "POST", headers: admin, body: JSON.stringify({ ttlHours: 2 }) })).status).toBe(404);
    expect((await fetch(base + `${UNIT}/authorize-holdout`, { method: "POST", headers: admin, body: JSON.stringify({ ttlHours: "soon" }) })).status).toBe(400);
    expect((await fetch(base + `${UNIT}/authorize-holdout`, { method: "POST", headers: admin, body: JSON.stringify({ ttlHours: 9999 }) })).status).toBe(400);
    expect((await fetch(base + `${RUN}/cancel`, { method: "POST", headers: admin })).status).toBe(404);
    for (const path of [`${UNIT}/evaluate-holdout`, `${UNIT}/register-model`, `${RUN}/work`, "/api/research/campaigns"]) expect((await fetch(base + path, { method: "POST", headers: admin, body: "{}" })).status).toBe(404);
  });
});
