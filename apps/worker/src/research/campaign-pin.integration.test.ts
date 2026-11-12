import { createCampaign, pinDataset, startRun } from "@odin/evolution/campaign";
import { PrismaClient } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * OPERATION INTEGRITY F07: dataset pinning must be atomic. Two workers that loaded different snapshots of one
 * dataset, released together from a barrier, must not both be allowed to proceed. Real Postgres, separate
 * connections (one PrismaClient per worker). SYNTHETIC campaign; no bars are evaluated.
 */
const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function barrier(n: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return async () => {
    arrived += 1;
    if (arrived === n) release();
    await gate;
  };
}

const identity = (contentHash: string) => ({ contentHash, bars: 100, firstT: "2024-01-01T00:00:00.000Z", lastT: "2024-01-05T03:00:00.000Z" });

describe.skipIf(!enabled)("atomic dataset pinning (F07, Postgres)", () => {
  let a: PrismaClient;
  let b: PrismaClient;

  beforeAll(async () => {
    a = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    b = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    // Connect both before any barrier, so a slow first connection cannot serialise the "concurrent" workers.
    await Promise.all([a.$queryRaw`SELECT 1`, b.$queryRaw`SELECT 1`]);
  }, 60_000);
  afterAll(async () => {
    await a.$disconnect();
    await b.$disconnect();
  });

  async function freshRun(name: string) {
    const raw = {
      specVersion: "campaign-spec-1",
      name: `${name} ${suffix}`,
      synthetic: true,
      datasets: [{ key: "d", source: { kind: "FILE", path: "x.csv", sha256: "0".repeat(64) }, market: "FX", instrument: `EUR/P${suffix.toUpperCase()}`, interval: "1h", asOf: "2026-01-01T00:00:00Z" }],
      hypotheses: [{ kind: "STRATEGY", id: "hz_atr_breakout" }, { kind: "STRATEGY", id: "hz_vol_expansion" }],
      validation: { seed: 1 },
      ml: { seed: 1 },
      limits: { maxTrials: 5000, maxRuntimeMsPerUnit: 120_000, maxMemoryMbPerUnit: 1024, maxConcurrency: 2, maxAttemptsPerUnit: 3 },
      holdoutPolicy: "WITHHELD_UNLESS_AUTHORIZED",
    };
    const { campaign } = await createCampaign(a, raw, "it");
    const { run } = await startRun(a, { campaignId: campaign.id, requestedBy: "it", codeVersion: "abc1234" });
    const units = await a.researchCampaignUnit.findMany({ where: { runId: run.id }, orderBy: { seq: "asc" } });
    return { runId: run.id, units };
  }

  const pinsOf = (runId: string) => a.researchCampaignEvent.findMany({ where: { runId, kind: "DATASET_PINNED" } });

  it("demonstrates the race in the old unlocked read-then-insert pattern", async () => {
    const { runId, units } = await freshRun("pin race old");
    const wait = barrier(2);
    const oldPin = async (db: PrismaClient, unitId: string, hash: string) => {
      const pins = await db.researchCampaignEvent.findMany({ where: { runId, kind: "DATASET_PINNED" } });
      const pinned = pins.find((p) => (p.detail as { datasetKey?: string }).datasetKey === "d");
      await wait(); // both workers have read "no pin"
      if (!pinned) await db.researchCampaignEvent.create({ data: { runId, unitId, kind: "DATASET_PINNED", actor: "it", detail: { datasetKey: "d", contentHash: hash } } });
      return pinned ? "COMPARED" : "PINNED";
    };
    const outcomes = await Promise.all([oldPin(a, units[0]!.id, "hash-A"), oldPin(b, units[1]!.id, "hash-B")]);
    // Expected from the defect: both accept their own, different snapshot.
    expect(outcomes).toEqual(["PINNED", "PINNED"]);
    expect(await pinsOf(runId)).toHaveLength(2);
  });

  it("two workers with different snapshots: exactly one pins, the other is refused", async () => {
    const { runId, units } = await freshRun("pin race different");
    const wait = barrier(2);
    const outcomes = await Promise.all([
      wait().then(() => pinDataset(a, { runId, unitId: units[0]!.id, datasetKey: "d", actor: "w1", identity: identity("hash-A") })),
      wait().then(() => pinDataset(b, { runId, unitId: units[1]!.id, datasetKey: "d", actor: "w2", identity: identity("hash-B") })),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["MISMATCH", "PINNED"]);
    const winner = outcomes.find((o) => o.status === "PINNED")!.contentHash;
    const loser = outcomes.find((o) => o.status === "MISMATCH")!;
    expect(loser.status === "MISMATCH" && loser.pinnedHash).toBe(winner);
    const pins = await pinsOf(runId);
    expect(pins).toHaveLength(1);
    expect((pins[0]!.detail as { contentHash: string }).contentHash).toBe(winner);
  });

  it("two workers with the same snapshot: one authoritative pin, both consistent", async () => {
    const { runId, units } = await freshRun("pin race same");
    const wait = barrier(2);
    const outcomes = await Promise.all([
      wait().then(() => pinDataset(a, { runId, unitId: units[0]!.id, datasetKey: "d", actor: "w1", identity: identity("hash-S") })),
      wait().then(() => pinDataset(b, { runId, unitId: units[1]!.id, datasetKey: "d", actor: "w2", identity: identity("hash-S") })),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["MATCHES", "PINNED"]);
    expect(await pinsOf(runId)).toHaveLength(1);
  });

  it("a retry after the dataset changed (later backfill) is refused against the original pin", async () => {
    const { runId, units } = await freshRun("pin backfill");
    expect((await pinDataset(a, { runId, unitId: units[0]!.id, datasetKey: "d", actor: "w1", identity: identity("hash-v1") })).status).toBe("PINNED");
    const later = await pinDataset(b, { runId, unitId: units[0]!.id, datasetKey: "d", actor: "w1", identity: identity("hash-v2-backfilled") });
    expect(later).toEqual({ status: "MISMATCH", contentHash: "hash-v2-backfilled", pinnedHash: "hash-v1" });
    expect(await pinsOf(runId)).toHaveLength(1);
  });
});
