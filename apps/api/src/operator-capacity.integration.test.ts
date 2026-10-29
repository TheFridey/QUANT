/**
 * Capacity / instance controls / safety recovery / why-no-trades against a real Postgres
 * (DATABASE_URL_TEST, e.g. odin_test_ui). Exact Decimal strings, account-scoped.
 */
import { ConflictException, BadRequestException, NotFoundException } from "@nestjs/common";
import { DEFAULT_STRATEGY, INTEGRATION_TEST_ADVISORY_LOCK, buildPositionKey, parseStrategyConfig } from "@odin/shared";
import { ensureFoundation } from "@odin/shared/bootstrap";
import { PrismaClient, toJson } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OperatorCapacityService } from "./operator-capacity.service.js";
import { TerminalService } from "./terminal.service.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

const ACCOUNT = "primary";
const SHARED_PAIR = "SharedPair1111111111111111111111111111111111";
const SOLO_PAIR = "SoloPair22222222222222222222222222222222222";
const INST_A = "stratinst_cap_a";
const INST_B = "stratinst_cap_b";
const INST_OTHER = "stratinst_cap_other";
const LIFE_SHARED = "life_shared_1";
const LIFE_SOLO = "life_solo_2";
const NOW = new Date("2026-10-29T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe.skipIf(!enabled)("OperatorCapacityService (DB)", () => {
  let prisma: PrismaClient;
  let service: OperatorCapacityService;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(${INTEGRATION_TEST_ADVISORY_LOCK})`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Fill", "LedgerEntry", "Order", "Position", "AgentDecision", "CycleRun", "PaperAccount", "EngineControl", "User",
       "RiskReservationEvent", "RiskReservation", "ProtectionIntent", "ProtectionOrder", "StrategyInstance", "StrategyAllocation",
       "DurableAlert", "AccountSafetyState", "TradeIntent", "RecoveryCase", "ReconciliationRun", "ObservabilityEvent", "MarketSelection"
       RESTART IDENTITY CASCADE`,
    );
    await ensureFoundation(prisma, {
      email: "admin@odin.local",
      password: "odin-paper-dev",
      config: parseStrategyConfig({ ...DEFAULT_STRATEGY, tradingEnvironment: "MARKET_DATA_PAPER" }),
    });
    await prisma.engineControl.update({ where: { id: "primary" }, data: { status: "RUNNING" } });
    await prisma.paperAccount.create({
      data: { id: "other_acct", cashUsd: "1000", startingBalanceUsd: "1000", tradingEnvironment: "REPLAY" },
    });

    const instance = (id: string, name: string, budgetUsd: string, accountId = ACCOUNT) => ({
      id,
      name,
      version: "1.0.0",
      accountId,
      instrumentIds: [SHARED_PAIR],
      params: toJson({ lookback: 5 }),
      budgetUsd,
      moduleRef: "builtin:pulse@1",
    });
    await prisma.strategyInstance.createMany({
      data: [
        instance(INST_A, "Alpha momentum", "100"),
        instance(INST_B, "Beta breakout", "50"),
        instance(INST_OTHER, "Other account", "999", "other_acct"),
      ],
    });

    await prisma.position.createMany({
      data: [
        { accountId: ACCOUNT, pairAddress: SHARED_PAIR, baseSymbol: "SHR", baseQty: "10", avgCostUsd: "10", realizedPnlUsd: "0", lifecycleId: LIFE_SHARED },
        { accountId: ACCOUNT, pairAddress: SOLO_PAIR, baseSymbol: "SOLO", baseQty: "2", avgCostUsd: "5", realizedPnlUsd: "0", lifecycleId: LIFE_SOLO },
      ],
    });
    await prisma.strategyAllocation.createMany({
      data: [
        { accountId: ACCOUNT, strategyInstanceId: INST_A, instrumentId: SHARED_PAIR, pairAddress: SHARED_PAIR, lifecycleId: LIFE_SHARED, qty: "4", avgCostUsd: "10", committedCapitalUsd: "40", feesUsd: "0.12", realizedPnlUsd: "1.5", reservedExitQty: "1" },
        { accountId: ACCOUNT, strategyInstanceId: INST_B, instrumentId: SHARED_PAIR, pairAddress: SHARED_PAIR, lifecycleId: LIFE_SHARED, qty: "3", avgCostUsd: "10", committedCapitalUsd: "30", feesUsd: "0.09" },
        { accountId: "other_acct", strategyInstanceId: INST_OTHER, instrumentId: SHARED_PAIR, pairAddress: SHARED_PAIR, qty: "50", avgCostUsd: "1", committedCapitalUsd: "50" },
      ],
    });
    const reservation = (clientOrderId: string, status: string, remainingCashUsd: string, strategyInstanceId: string | null, accountId = ACCOUNT) => ({
      accountId,
      clientOrderId,
      status,
      cashUsd: remainingCashUsd,
      exposureUsd: remainingCashUsd,
      slots: 1,
      riskUsd: "1",
      remainingCashUsd,
      strategyInstanceId,
    });
    await prisma.riskReservation.createMany({
      data: [
        reservation("co_a_1", "HELD", "25", INST_A),
        reservation("co_a_2", "HELD", "5.5", INST_A),
        reservation("co_a_3", "CONSUMED", "40", INST_A),
        reservation("co_b_1", "RELEASED", "20", INST_B),
        reservation("co_other", "HELD", "500", INST_OTHER, "other_acct"),
      ],
    });
    await prisma.protectionOrder.createMany({
      data: [
        { accountId: ACCOUNT, positionKey: buildPositionKey(ACCOUNT, SHARED_PAIR), ocoGroupId: "oco1", lifecycleId: LIFE_SHARED, kind: "STOP", origin: "SYNTHETIC_ENGINE", status: "ARMED", ackState: "ACKED", protectedQty: "10", remainingQty: "10", triggerPriceUsd: "9" },
        { accountId: ACCOUNT, positionKey: buildPositionKey(ACCOUNT, SOLO_PAIR), ocoGroupId: "oco2", lifecycleId: "life_old", kind: "STOP", origin: "SYNTHETIC_ENGINE", status: "ARMED", ackState: "ACKED", protectedQty: "2", remainingQty: "2", triggerPriceUsd: "4" },
        { accountId: ACCOUNT, positionKey: buildPositionKey(ACCOUNT, SOLO_PAIR), ocoGroupId: "oco3", lifecycleId: LIFE_SOLO, kind: "STOP", origin: "VENUE_NATIVE", status: "ARMED", ackState: "DESIRED_ONLY", protectedQty: "2", remainingQty: "2", triggerPriceUsd: "4" },
      ],
    });
    const intent = (id: string, status: string, statusReason: string | null, strategyInstanceId: string, pairAddress = SHARED_PAIR, createdAt = minutesAgo(10)) => ({
      id,
      idempotencyKey: `key_${id}`,
      cycleId: "cyc_wnt",
      accountId: ACCOUNT,
      tradingEnvironment: "MARKET_DATA_PAPER",
      source: "STRATEGY",
      strategyInstanceId,
      instrumentId: pairAddress,
      pairAddress,
      action: "ENTER",
      side: "BUY",
      reasonCodes: [] as string[],
      status,
      statusReason,
      createdAt,
    });
    await prisma.tradeIntent.createMany({
      data: [
        intent("ti_b_deferred", "DEFERRED", "INSTANCE_BUDGET_EXHAUSTED", INST_B),
        intent("ti_a_fair", "DEFERRED", "WAITING_FAIR_ALLOCATION: shared symbol owned this cycle", INST_A),
        intent("ti_a_filled", "FILLED", null, INST_A),
        { ...intent("ti_env_other", "DEFERRED", "INSTANCE_BUDGET_EXHAUSTED", INST_A), tradingEnvironment: "REPLAY" },
      ],
    });
    await prisma.recoveryCase.createMany({
      data: [
        { dedupeKey: "drift:shared", accountId: ACCOUNT, kind: "ALLOCATION_DRIFT", pairAddress: SHARED_PAIR, detail: toJson({ localQty: "10", allocatedQty: "7" }) },
        { dedupeKey: "old:resolved", accountId: ACCOUNT, kind: "UNKNOWN_SUBMISSION", status: "RESOLVED", detail: toJson({}) },
        { dedupeKey: "other:acct", accountId: "other_acct", kind: "BROKER_DRIFT", detail: toJson({}) },
      ],
    });
    await prisma.reconciliationRun.createMany({
      data: [
        { accountId: ACCOUNT, scope: "LOCAL_ALLOCATION", venue: "PAPER", startedAt: minutesAgo(30), completedAt: minutesAgo(29), status: "DRIFT", complete: true, coverage: toJson({}), differences: toJson([{ pairAddress: SOLO_PAIR }]) },
        { accountId: ACCOUNT, scope: "LOCAL_ALLOCATION", venue: "PAPER", startedAt: minutesAgo(3), completedAt: minutesAgo(2), status: "CLEAN", complete: true, coverage: toJson({ positions: 2 }), differences: toJson([]) },
      ],
    });
    await prisma.accountSafetyState.create({
      data: { accountId: ACCOUNT, code: "ENTRIES_SUSPENDED", status: "ACTIVE", detail: toJson({ reason: "test" }) },
    });

    service = new OperatorCapacityService(prisma);
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(${INTEGRATION_TEST_ADVISORY_LOCK})`;
    await prisma.$disconnect();
  });

  it("reports per-instance budget, filled, pending, available and owned allocations with exact decimals", async () => {
    const view = await service.capacity(NOW);
    expect(view.accountId).toBe(ACCOUNT);
    expect(view.tradingEnvironment).toBe("MARKET_DATA_PAPER");
    expect(view.instances.map((row) => row.id).sort()).toEqual([INST_A, INST_B]);

    const a = view.instances.find((row) => row.id === INST_A)!;
    expect(a.budgetUsd).toBe("100.00000000");
    expect(a.filledCommittedUsd).toBe("40.00000000");
    expect(a.pendingCommittedUsd).toBe("30.50000000");
    expect(a.availableUsd).toBe("29.50000000");
    expect(a.allocations).toEqual([
      {
        pairAddress: SHARED_PAIR,
        instrumentId: SHARED_PAIR,
        qty: "4.00000000",
        reservedExitQty: "1.00000000",
        avgCostUsd: "10.00000000",
        committedCapitalUsd: "40.00000000",
        realizedPnlUsd: "1.50000000",
        feesUsd: "0.12000000",
        ownership: "STRATEGY",
        costBasisKnown: true,
      },
    ]);
    expect(a.waitingIntents.map((row) => [row.id, row.family])).toEqual([["ti_a_fair", "WAITING_FAIR_ALLOCATION"]]);

    const b = view.instances.find((row) => row.id === INST_B)!;
    expect(b.filledCommittedUsd).toBe("30.00000000");
    expect(b.pendingCommittedUsd).toBe("0.00000000");
    expect(b.availableUsd).toBe("20.00000000");
    expect(b.waitingIntents).toHaveLength(1);
    expect(b.waitingIntents[0]).toMatchObject({
      id: "ti_b_deferred",
      status: "DEFERRED",
      statusReason: "INSTANCE_BUDGET_EXHAUSTED",
      family: "INSTANCE_BUDGET_EXHAUSTED",
      familyLabel: "Instance budget exhausted",
    });

    expect(view.totals).toEqual({
      budgetUsd: "150.00000000",
      filledCommittedUsd: "70.00000000",
      pendingCommittedUsd: "30.50000000",
      availableUsd: "49.50000000",
    });
  });

  it("reports net positions with owned vs unattributed qty, current-lifecycle protection, and reconcile status", async () => {
    const view = await service.capacity(NOW);
    const shared = view.netPositions.find((row) => row.pairAddress === SHARED_PAIR)!;
    expect(shared.localQty).toBe("10.00000000");
    expect(shared.allocatedQty).toBe("7.00000000");
    expect(shared.unattributedQty).toBe("3.00000000");
    expect(shared.overAllocatedQty).toBe("0.00000000");
    expect(shared.owners.map((row) => [row.strategyInstanceId, row.qty])).toEqual([
      [INST_A, "4.00000000"],
      [INST_B, "3.00000000"],
    ]);
    expect(shared.protection).toEqual({ status: "PROTECTED", coveredQty: "10.00000000", legCount: 1 });
    expect(shared.reconciliation).toBe("RECOVERY_OPEN");

    const solo = view.netPositions.find((row) => row.pairAddress === SOLO_PAIR)!;
    expect(solo.allocatedQty).toBe("0.00000000");
    expect(solo.unattributedQty).toBe("2.00000000");
    // The ARMED+ACKED leg belongs to an old lifecycle; the current leg is desired but unacknowledged.
    expect(solo.protection.status).toBe("REQUESTED");
    expect(solo.reconciliation).toBe("CLEAN");

    expect(view.recoveryCases.map((row) => [row.kind, row.pairAddress])).toEqual([["ALLOCATION_DRIFT", SHARED_PAIR]]);
    expect(view.reconciliation.localAllocation).toMatchObject({ status: "CLEAN", complete: true, ageMs: 120_000 });
    expect(view.reconciliation.broker).toBeNull();
    expect(view.entriesSuspended).toBe(true);
  });

  it("patches instance status/budget for the current account only, audited, without touching module or params", async () => {
    const result = await service.updateStrategyInstance(INST_A, { status: "PAUSED", budgetUsd: "20" }, "ops@odin.local");
    expect(result.changed).toBe(true);
    expect(result.before).toEqual({ status: "ACTIVE", budgetUsd: "100.00000000" });
    expect(result.after).toEqual({ status: "PAUSED", budgetUsd: "20.00000000" });
    const row = await prisma.strategyInstance.findUniqueOrThrow({ where: { id: INST_A } });
    expect(row.moduleRef).toBe("builtin:pulse@1");
    expect(row.params).toEqual({ lookback: 5 });
    const audit = await prisma.observabilityEvent.findFirstOrThrow({
      where: { category: "OPERATOR_AUDIT", name: "strategy_instance.update" },
    });
    expect(audit.meta).toMatchObject({ actor: "ops@odin.local", strategyInstanceId: INST_A, accountId: ACCOUNT });

    // Budget below committed: no sale, availability floors at zero and over-commit is reported.
    const view = await service.capacity(NOW);
    const a = view.instances.find((item) => item.id === INST_A)!;
    expect(a.availableUsd).toBe("0.00000000");
    expect(a.overCommittedUsd).toBe("50.50000000");
    expect(await prisma.order.count()).toBe(0);
    expect((await prisma.position.findUniqueOrThrow({ where: { accountId_pairAddress: { accountId: ACCOUNT, pairAddress: SHARED_PAIR } } })).baseQty.toString()).toBe("10");

    await expect(service.updateStrategyInstance(INST_OTHER, { status: "PAUSED" }, "ops")).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateStrategyInstance(INST_B, { budgetUsd: "-1" }, "ops")).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateStrategyInstance(INST_B, { moduleRef: "x" }, "ops")).rejects.toBeInstanceOf(BadRequestException);
    expect((await prisma.strategyInstance.findUniqueOrThrow({ where: { id: INST_OTHER } })).status).toBe("ACTIVE");
  });

  it("explains no-trades by decisive family with active conditions first and exact counts", async () => {
    await prisma.cycleRun.create({
      data: {
        id: "cyc_wnt",
        trigger: "schedule",
        status: "COMPLETE",
        stage: "complete",
        dataState: "LIVE",
        accountId: ACCOUNT,
        tradingEnvironment: "MARKET_DATA_PAPER",
        startedAt: minutesAgo(10),
      },
    });
    await prisma.cycleRun.create({
      data: { id: "cyc_old", trigger: "schedule", status: "COMPLETE", stage: "complete", dataState: "LIVE", accountId: ACCOUNT, tradingEnvironment: "MARKET_DATA_PAPER", startedAt: minutesAgo(60 * 30) },
    });
    const decision = (cycleId: string, agent: string, pairAddress: string, verdict: string, reasonCodes: string[]) => ({
      cycleId,
      agent,
      modelVersion: "test",
      pairAddress,
      decision: verdict,
      confidence: "1",
      reasonCodes,
      input: toJson({}),
      output: toJson({}),
      createdAt: minutesAgo(10),
    });
    await prisma.agentDecision.createMany({
      data: [
        decision("cyc_wnt", "PULSE", "pairQuiet", "HOLD", ["NO_EDGE"]),
        decision("cyc_wnt", "ATLAS", "pairQuiet", "HOLD", ["NO_INTENT"]),
        decision("cyc_wnt", "AEGIS", "pairRisky", "REJECT", ["SECURITY_BLOCK"]),
        decision("cyc_wnt", "ATLAS", "pairRisky", "HOLD", ["NO_INTENT"]),
        decision("cyc_wnt", "AEGIS", "pairOk", "PASS", ["SECURITY_PASS"]),
        decision("cyc_wnt", "EXECUTOR", "pairOk", "ACT", ["ORDER_PROPOSED"]),
        decision("cyc_old", "PULSE", "pairAncient", "HOLD", ["NO_EDGE"]),
      ],
    });

    const why = await service.whyNoTrades("24H", NOW);
    expect(why.window).toBe("24H");
    expect(why.cyclesInWindow).toBe(1);
    expect(why.evaluations).toBe(3);
    expect(why.actedEvaluations).toBe(1);
    const byId = new Map(why.families.map((row) => [row.id, row]));
    expect(byId.get("NO_ELIGIBLE_SIGNAL")).toMatchObject({ count: 1, evaluationCount: 1, activeNow: false });
    expect(byId.get("SECURITY_SCREEN")).toMatchObject({ count: 1, evaluationCount: 1 });
    expect(byId.get("INSTANCE_BUDGET_EXHAUSTED")).toMatchObject({ count: 1, intentCount: 1 });
    expect(byId.get("INSTANCE_BUDGET_EXHAUSTED")!.samples[0]).toMatchObject({ id: "ti_b_deferred", strategyInstanceId: INST_B });
    expect(byId.get("WAITING_FAIR_ALLOCATION")).toMatchObject({ count: 1, intentCount: 1 });
    expect(byId.get("SAFETY_SUSPENSION")).toMatchObject({ activeNow: true, count: 0 });
    expect(byId.get("STRATEGY_PAUSED")).toMatchObject({ activeNow: true, activeCount: 1 });
    expect(byId.get("RECONCILIATION_REQUIRED")).toMatchObject({ activeNow: true });
    expect(why.primary).toMatchObject({ id: "SAFETY_SUSPENSION", basis: "ACTIVE_CONDITION" });
    expect(why.families.slice(0, 3).every((row) => row.activeNow)).toBe(true);
  });

  it("refuses safety recovery with structured unmet prerequisites; ACK never clears; clean prerequisites resolve", async () => {
    const terminal = new TerminalService(prisma, {} as never);
    const alert = await prisma.durableAlert.create({
      data: { accountId: ACCOUNT, severity: "ERROR", code: "ENTRIES_SUSPENDED", message: "Entries suspended" },
    });
    await terminal.ackAlert(alert.id, "ops@odin.local");
    expect((await prisma.accountSafetyState.findFirstOrThrow({ where: { accountId: ACCOUNT, code: "ENTRIES_SUSPENDED" } })).status).toBe("ACTIVE");

    await prisma.order.create({
      data: { clientOrderId: "co_unknown", cycleId: "cyc_wnt", accountId: ACCOUNT, pairAddress: SHARED_PAIR, baseSymbol: "SHR", side: "BUY", intent: "ENTRY", status: "PENDING", qty: "1", submissionState: "UNKNOWN" },
    });
    const pre = await service.recoveryPrerequisites(NOW);
    expect(pre.ready).toBe(false);
    expect(pre.unmet.map((row) => row.code)).toEqual(["OPEN_RECOVERY_CASES", "UNKNOWN_SUBMISSIONS"]);

    let conflict: unknown = null;
    try {
      await service.recoverSafety("ops@odin.local", NOW);
    } catch (caught) {
      conflict = caught;
    }
    expect(conflict).toBeInstanceOf(ConflictException);
    const response = (conflict as ConflictException).getResponse() as { code: string; unmet: Array<{ code: string }> };
    expect(response.code).toBe("RECOVERY_PREREQUISITES_UNMET");
    expect(response.unmet.map((row) => row.code)).toEqual(["OPEN_RECOVERY_CASES", "UNKNOWN_SUBMISSIONS"]);
    expect((await prisma.accountSafetyState.findFirstOrThrow({ where: { accountId: ACCOUNT, code: "ENTRIES_SUSPENDED" } })).status).toBe("ACTIVE");

    // A stale clean reconcile is not enough.
    await prisma.recoveryCase.updateMany({ where: { accountId: ACCOUNT, status: "OPEN" }, data: { status: "RESOLVED" } });
    await prisma.order.updateMany({ where: { clientOrderId: "co_unknown" }, data: { submissionState: "TERMINAL" } });
    const later = new Date(NOW.getTime() + 60 * 60_000);
    expect((await service.recoveryPrerequisites(later)).unmet.map((row) => row.code)).toEqual(["RECONCILE_STALE"]);

    const done = await service.recoverSafety("ops@odin.local", NOW);
    expect(done).toMatchObject({ resolved: true, resolvedCodes: ["ENTRIES_SUSPENDED"] });
    expect((await prisma.accountSafetyState.findFirstOrThrow({ where: { accountId: ACCOUNT, code: "ENTRIES_SUSPENDED" } })).status).toBe("RESOLVED");
    const audit = await prisma.observabilityEvent.findFirstOrThrow({ where: { category: "OPERATOR_AUDIT", name: "safety.recover" } });
    expect(audit.meta).toMatchObject({ actor: "ops@odin.local", accountId: ACCOUNT, resolvedCodes: ["ENTRIES_SUSPENDED"] });
  });
});
