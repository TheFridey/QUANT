/**
 * OPERATION HORIZON: the opportunity scanner endpoints sit behind the global JWT guard, only read, and bound
 * every query. Boots a real Nest HTTP app with the production JwtAuthGuard and a stub Prisma client.
 */
import "reflect-metadata";
import { Module, UnauthorizedException, type INestApplication } from "@nestjs/common";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import { PrismaClient } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JwtAuthGuard } from "./http.js";
import { OpportunitiesController } from "./opportunities.controller.js";
import { OPPORTUNITY_BOUNDS, OpportunitiesService } from "./opportunities.service.js";

type Call = { name: string; args: Record<string, unknown> | undefined };
const calls: Call[] = [];
const stub = (name: string, value: unknown) => (args?: Record<string, unknown>) => {
  calls.push({ name, args });
  return Promise.resolve(value);
};
// Read methods only: any write would throw (no create/update/delete/upsert on the stub).
const prismaStub = {
  engineControl: { findUnique: stub("engineControl.findUnique", null) },
  marketSelection: { findMany: stub("marketSelection.findMany", []) },
  strategyInstance: { findMany: stub("strategyInstance.findMany", []) },
  shadowPrediction: { findMany: stub("shadowPrediction.findMany", []) },
  modelVersion: { findMany: stub("modelVersion.findMany", []) },
  ledgerEntry: { findMany: stub("ledgerEntry.findMany", []) },
  position: { findMany: stub("position.findMany", []) },
  order: { findMany: stub("order.findMany", []) },
  historicalDataset: { findMany: stub("historicalDataset.findMany", []) },
  researchCampaignResult: { findMany: stub("researchCampaignResult.findMany", []) },
  marketObservation: { findFirst: stub("marketObservation.findFirst", null), findMany: stub("marketObservation.findMany", []) },
};
const auth = {
  verify: async (token: string) => {
    if (token !== "valid-token") throw new UnauthorizedException("Invalid token");
    return { id: "u1", email: "viewer@odin.local", role: "VIEWER" };
  },
};

Reflect.defineMetadata("design:paramtypes", [PrismaClient], OpportunitiesService);
Reflect.defineMetadata("design:paramtypes", [OpportunitiesService], OpportunitiesController);

class TestModule {}
Module({
  controllers: [OpportunitiesController],
  providers: [
    OpportunitiesService,
    { provide: PrismaClient, useValue: prismaStub },
    { provide: APP_GUARD, useFactory: (reflector: Reflector) => new JwtAuthGuard(reflector, auth as never), inject: [Reflector] },
  ],
})(TestModule);

type Body = {
  markets: Array<{ id: string; readiness: { state: string; reasons: Array<{ code: string }> } }>;
  leaderboard: { selected: number; rows: Array<{ instrumentId: string; decision: string }> };
};

describe("HORIZON opportunity scanner endpoints", () => {
  let app: INestApplication;
  let base = "";
  const headers = { authorization: "Bearer valid-token" };

  beforeAll(async () => {
    app = await NestFactory.create(TestModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  });

  afterAll(async () => {
    await app.close();
  });

  for (const path of ["/api/research/opportunities", "/api/research/markets/commodity:XAUUSD"]) {
    it(`GET ${path} without a valid token is 401 and never reaches the database`, async () => {
      const before = calls.length;
      expect((await fetch(base + path)).status).toBe(401);
      expect((await fetch(base + path, { headers: { authorization: "Bearer forged" } })).status).toBe(401);
      expect(calls.length).toBe(before);
    });
  }

  it("serves honest states: gold has no provider, nothing is READY from the registry alone, empty leaderboard", async () => {
    calls.length = 0;
    const response = await fetch(base + "/api/research/opportunities", { headers });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Body;
    const gold = body.markets.find((m) => m.id === "commodity:XAUUSD")!;
    expect(gold.readiness.state).toBe("NO_PROVIDER");
    expect(body.markets.every((m) => !["OBSERVABLE", "RESEARCH_ONLY", "PAPER_EXECUTABLE"].includes(m.readiness.state))).toBe(true);
    expect(body.leaderboard.selected).toBe(0);
    expect(body.leaderboard.rows.find((r) => r.instrumentId === "commodity:XAUUSD")!.decision).toBe("NOT_EVALUATED");
  });

  it("bounds every list query on a growing table", async () => {
    calls.length = 0;
    expect((await fetch(base + "/api/research/opportunities", { headers })).status).toBe(200);
    const limits: Record<string, number> = {
      "strategyInstance.findMany": OPPORTUNITY_BOUNDS.strategyInstances,
      "shadowPrediction.findMany": OPPORTUNITY_BOUNDS.shadowRows,
      "ledgerEntry.findMany": OPPORTUNITY_BOUNDS.realisedEntries,
      "position.findMany": OPPORTUNITY_BOUNDS.positions,
      "marketObservation.findMany": OPPORTUNITY_BOUNDS.volatilityPoints,
      "historicalDataset.findMany": 2_000,
      "researchCampaignResult.findMany": 300,
    };
    const listed = calls.filter((c) => c.name in limits);
    expect(listed.length).toBeGreaterThanOrEqual(4);
    for (const call of listed) {
      expect(call.args?.take, call.name).toBeTypeOf("number");
      expect(call.args!.take as number, call.name).toBeLessThanOrEqual(limits[call.name]!);
    }
    // Only reads were issued.
    expect(calls.every((c) => /\.(findMany|findFirst|findUnique)$/.test(c.name))).toBe(true);
  });

  it("serves per-market diagnostics, 404s unknown and 400s malformed ids", async () => {
    const response = await fetch(base + "/api/research/markets/fx:EURUSD", { headers });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { market: Body["markets"][number] };
    expect(body.market.id).toBe("fx:EURUSD");
    expect(body.market.readiness.state).not.toBe("PAPER_EXECUTABLE");
    expect((await fetch(base + "/api/research/markets/fx:NOPE", { headers })).status).toBe(404);
    expect((await fetch(base + "/api/research/markets/" + encodeURIComponent("bad id!"), { headers })).status).toBe(400);
  });

  it("does not accept writes", async () => {
    expect((await fetch(base + "/api/research/opportunities", { method: "POST", headers })).status).toBe(404);
    expect((await fetch(base + "/api/research/markets/fx:EURUSD", { method: "POST", headers })).status).toBe(404);
  });
});
