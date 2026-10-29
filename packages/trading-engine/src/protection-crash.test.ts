import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@odin/shared/db";
import { newId } from "@odin/shared";
import {
  amendProtectionTriggerInTx,
  armLongShortOco,
  claimOcoTrigger,
  persistOcoGroup,
  recoverProtectionAfterRestart,
  retryUnresolvedProtectionIntents,
} from "./protection-lifecycle.js";
import { amendProtectionTrigger, evaluateOco } from "./protection.js";

const hasDb = Boolean(process.env.DATABASE_URL || process.env.DATABASE_URL_TEST);

describe("protection amendment keeps last confirmed", () => {
  it("failed amend restores confirmed trigger", () => {
    const group = armLongShortOco({
      groupId: "amd1",
      positionKey: "primary:etf:SPY",
      direction: "LONG",
      qty: "10",
      entryPriceUsd: "100",
      stopLossPct: "3",
      takeProfitPct: "5",
    });
    const stop = group.legs.find((l) => l.kind === "STOP")!;
    expect(stop.confirmedTriggerPriceUsd).toBe(stop.triggerPriceUsd);
    const failed = amendProtectionTrigger(group, stop.id, "95.00000000", {
      ok: false,
      error: "VENUE_REJECT",
    });
    expect(failed.keptConfirmed).toBe(true);
    const after = failed.group.legs.find((l) => l.id === stop.id)!;
    expect(after.triggerPriceUsd).toBe(stop.triggerPriceUsd);
    expect(after.desiredTriggerPriceUsd).toBe("95.00000000");
    expect(after.ackState).toBe("ACKED");
  });

  it("successful amend updates confirmed", () => {
    const group = armLongShortOco({
      groupId: "amd2",
      positionKey: "p",
      direction: "LONG",
      qty: "1",
      entryPriceUsd: "100",
      stopLossPct: "3",
      takeProfitPct: "5",
    });
    const stop = group.legs.find((l) => l.kind === "STOP")!;
    const ok = amendProtectionTrigger(group, stop.id, "96.50000000", { ok: true });
    expect(ok.error).toBeNull();
    const after = ok.group.legs.find((l) => l.id === stop.id)!;
    expect(after.triggerPriceUsd).toBe("96.50000000");
    expect(after.confirmedTriggerPriceUsd).toBe("96.50000000");
  });
});

describe.runIf(hasDb)("multi-worker OCO crash/restart harness", () => {
  const prisma = createPrismaClient();
  const accountId = "primary:protection-crash-test";

  beforeAll(async () => {
    await prisma.paperAccount.upsert({
      where: { id: accountId },
      create: {
        id: accountId,
        cashUsd: "100000",
        startingBalanceUsd: "100000",
        tradingEnvironment: "MARKET_DATA_PAPER",
      },
      update: {},
    });
  });

  async function reset() {
    await prisma.protectionIntent.deleteMany({ where: { accountId } });
    await prisma.protectionOrder.deleteMany({ where: { accountId } });
  }

  afterAll(async () => {
    await reset();
    await prisma.paperAccount.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it("two workers racing claimOcoTrigger — exactly one wins", async () => {
    await reset();
    const groupId = `oco_race_${newId("g")}`;
    const group = armLongShortOco({
      groupId,
      positionKey: `${accountId}:etf:SPY`,
      direction: "LONG",
      qty: "5",
      entryPriceUsd: "100",
      stopLossPct: "3",
      takeProfitPct: "5",
    });
    await persistOcoGroup(prisma, { accountId, group });

    const results = await Promise.all([
      claimOcoTrigger(prisma, { ocoGroupId: groupId, markUsd: "96", workerId: "w1" }),
      claimOcoTrigger(prisma, { ocoGroupId: groupId, markUsd: "96", workerId: "w2" }),
    ]);
    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    if (!losses[0]!.ok) expect(losses[0].reason).toBe("RACE_LOST");
    const triggered = await prisma.protectionOrder.count({
      where: { ocoGroupId: groupId, status: "TRIGGERED" },
    });
    const cancelled = await prisma.protectionOrder.count({
      where: { ocoGroupId: groupId, status: "CANCELLED" },
    });
    expect(triggered).toBe(1);
    expect(cancelled).toBe(1);
  });

  it("amendment failure persists last confirmed trigger + unresolved intent", async () => {
    await reset();
    const groupId = `oco_amd_${newId("g")}`;
    const group = armLongShortOco({
      groupId,
      positionKey: `${accountId}:fx:EURUSD`,
      direction: "LONG",
      qty: "1000",
      entryPriceUsd: "1.10000000",
      stopLossPct: "2",
      takeProfitPct: "3",
    });
    await persistOcoGroup(prisma, { accountId, group });
    const stop = group.legs.find((l) => l.kind === "STOP")!;
    const confirmedBefore = stop.triggerPriceUsd!;

    const result = await prisma.$transaction((tx) =>
      amendProtectionTriggerInTx(tx, {
        ocoGroupId: groupId,
        legId: stop.id,
        nextTriggerPriceUsd: "1.05000000",
        outcome: { ok: false, error: "VENUE_REJECT" },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.keptConfirmed).toBe(true);

    const row = await prisma.protectionOrder.findUnique({ where: { id: stop.id } });
    expect(Number(row?.triggerPriceUsd?.toString())).toBeCloseTo(Number(confirmedBefore), 6);
    expect(Number(row?.confirmedTriggerPriceUsd?.toString())).toBeCloseTo(Number(confirmedBefore), 6);
    expect(Number(row?.desiredTriggerPriceUsd?.toString())).toBeCloseTo(1.05, 6);
    expect(row?.ackState).toBe("ACKED");

    const intents = await prisma.protectionIntent.count({
      where: { accountId, status: "UNRESOLVED" },
    });
    expect(intents).toBe(1);
  });

  it("crash mid-TRIGGERED → recover creates durable unresolved intent; retry can resolve", async () => {
    await reset();
    const groupId = `oco_crash_${newId("g")}`;
    const group = armLongShortOco({
      groupId,
      positionKey: `${accountId}:etf:QQQ`,
      direction: "LONG",
      qty: "2",
      entryPriceUsd: "400",
      stopLossPct: "3",
      takeProfitPct: "5",
    });
    await persistOcoGroup(prisma, { accountId, group });
    const claim = await claimOcoTrigger(prisma, {
      ocoGroupId: groupId,
      markUsd: "380",
      workerId: "w-crash",
    });
    expect(claim.ok).toBe(true);
    // Simulate crash: leave TRIGGERED without fill / intent.

    const recovery = await recoverProtectionAfterRestart(prisma, { accountId });
    expect(recovery.unresolvedIntents).toBeGreaterThanOrEqual(1);

    const leg = await prisma.protectionOrder.findFirst({
      where: { ocoGroupId: groupId, kind: "STOP" },
    });
    expect(leg?.status).toBe("FAILED");

    let attempts = 0;
    const retry = await retryUnresolvedProtectionIntents(prisma, {
      now: new Date(Date.now() + 60_000),
      attemptExit: async () => {
        attempts += 1;
        return { ok: true };
      },
    });
    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(retry.resolved).toBeGreaterThanOrEqual(1);
  });

  it("gap-through prefers STOP; second mark race-suppressed after claim", async () => {
    await reset();
    const groupId = `oco_gap_${newId("g")}`;
    const group = armLongShortOco({
      groupId,
      positionKey: `${accountId}:commodity:XAUUSD`,
      direction: "LONG",
      qty: "1",
      entryPriceUsd: "2650",
      stopLossPct: "2",
      takeProfitPct: "3",
    });
    // Both stop and TP would "hit" only if mark is wild; use stop-only mark then TP mark.
    const evalGap = evaluateOco(group, "2500");
    expect(evalGap.triggered?.kind).toBe("STOP");
    await persistOcoGroup(prisma, { accountId, group });
    const first = await claimOcoTrigger(prisma, {
      ocoGroupId: groupId,
      markUsd: "2500",
      workerId: "w-gap",
    });
    expect(first.ok).toBe(true);
    const second = await claimOcoTrigger(prisma, {
      ocoGroupId: groupId,
      markUsd: "2800",
      workerId: "w-gap-2",
    });
    expect(second.ok).toBe(false);
  });
});
