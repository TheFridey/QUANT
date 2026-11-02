import { DEFAULT_STRATEGY, d, type ExecutionContext } from "@odin/shared";
import { ensureFoundation } from "@odin/shared/bootstrap";
import { PrismaClient, toJson } from "@odin/shared/db";
import { lockAccount } from "@odin/trading-engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settlePendingPaperOrders } from "./settle.js";

/**
 * PCR-1 regression (APEX). A pending SELL is created for one position lot. If that lot is closed by
 * another path (typically protection in the same cycle) and a new lot is opened on the same pair before
 * the SELL settles, the SELL must not reduce the new lot.
 *
 * Reachable today: entry de-duplication is per strategy instance and pair, and operator tickets may buy a
 * held pair, so a pending BUY submitted before the stale SELL settles first (settle runs in submittedAt
 * order) and reopens the pair. The existing F5 guard only cancels a SELL while the pair is flat.
 */
const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));
const pairAddress = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const env = "MARKET_DATA_PAPER";

describe.skipIf(!enabled)("PCR-1: pending exits are fenced to their position lot", () => {
  let prisma: PrismaClient;
  const host = {
    dataMode: "live",
    buildReservationBudget: vi.fn().mockResolvedValue({}),
    armProtectionForFill: vi.fn(),
  } as unknown as Parameters<typeof settlePendingPaperOrders>[0];
  const ctx = { accountId: "primary", tradingEnvironment: env } as unknown as ExecutionContext;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Fill", "LedgerEntry", "Order", "Position", "MarketObservation", "PaperAccount", "EngineControl", "User", "RiskReservationEvent", "RiskReservation", "ProtectionIntent", "ProtectionOrder", "StrategyInstance", "StrategyAllocation", "TradeIntent", "DurableAlert", "AccountSafetyState" RESTART IDENTITY CASCADE`,
    );
    const config = { ...DEFAULT_STRATEGY, paperLatencyMs: 0, tradingEnvironment: env };
    await ensureFoundation(prisma, { email: "admin@odin.local", password: "odin-paper-dev", config });
    await prisma.engineControl.update({ where: { id: "primary" }, data: { status: "RUNNING", config: toJson(config) } });
  });

  async function observation(at: Date, ingestJobId: string) {
    return prisma.marketObservation.create({
      data: {
        ingestJobId,
        source: "dexscreener",
        chainId: "solana",
        pairAddress,
        dexId: "orca",
        baseAddress: "So11111111111111111111111111111111111111112",
        baseSymbol: "SOL",
        baseName: "Wrapped SOL",
        quoteAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        quoteSymbol: "USDC",
        priceUsd: "100",
        liquidityUsd: "1000000",
        freshness: "LIVE",
        dataOrigin: "LIVE_FEED",
        tradingEnvironment: env,
        receivedAt: at,
        eventTime: at,
        raw: {},
      },
    });
  }

  async function pending(input: { clientOrderId: string; side: "BUY" | "SELL"; intent: string; ownerScope: string; submittedAt: Date; observationId: string }) {
    return prisma.order.create({
      data: {
        clientOrderId: input.clientOrderId,
        cycleId: "cyc_pcr1",
        accountId: "primary",
        pairAddress,
        baseSymbol: "SOL",
        side: input.side,
        intent: input.intent,
        status: "PENDING",
        qty: "1",
        observationId: input.observationId,
        decisionObservationId: input.observationId,
        reasonCodes: ["ORDER_PENDING"],
        ownerScope: input.ownerScope,
        submittedAt: input.submittedAt,
        eligibleAt: input.submittedAt,
        expiresAt: new Date(input.submittedAt.getTime() + 60_000),
      },
    });
  }

  async function settle(now: Date) {
    return prisma.$transaction(async (tx) => {
      await lockAccount(tx, "primary");
      return settlePendingPaperOrders(host, tx, { ctx, now });
    });
  }

  it("a stale protective NET_CLOSE does not sell a lot opened after its own lot closed", async () => {
    const now = new Date();
    const t0 = new Date(now.getTime() - 10_000);
    const t1 = new Date(now.getTime() - 8_000);
    const decision = await observation(new Date(now.getTime() - 12_000), "cyc_pcr1_decision");
    await observation(new Date(now.getTime() - 1_000), "cyc_pcr1");
    // Lot L1 was closed by protection after the NET_CLOSE below was booked: the pair is flat.
    await prisma.position.create({ data: { accountId: "primary", pairAddress, baseSymbol: "SOL", baseQty: "0", avgCostUsd: "0", realizedPnlUsd: "0", lifecycleId: null } });
    // T0: an operator BUY on the pair, submitted while L1 was still open (allowed: operator tickets may add).
    await pending({ clientOrderId: "pcr1_buy", side: "BUY", intent: "OPERATOR", ownerScope: "OPERATOR", submittedAt: t0, observationId: decision.id });
    // T1: the planner's protective NET_CLOSE for L1, still pending when protection closed L1.
    await pending({ clientOrderId: "pcr1_stale_close", side: "SELL", intent: "EXIT", ownerScope: "NET_CLOSE", submittedAt: t1, observationId: decision.id });

    await settle(now);

    const buy = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_buy" } });
    const stale = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_stale_close" } });
    const position = await prisma.position.findFirstOrThrow({ where: { accountId: "primary", pairAddress } });
    expect(buy.status).toBe("FILLED");
    // Desired: the stale exit is cancelled and the new lot (L2) is untouched.
    expect(stale.status).toBe("CANCELLED");
    expect(stale.rejectReason).toBe("EXIT_LIFECYCLE_MISMATCH");
    expect(d(position.baseQty.toString()).toFixed(8)).toBe(d(buy.filledQty.toString()).toFixed(8));
    expect(position.lifecycleId).toBeTruthy();
  });
});
