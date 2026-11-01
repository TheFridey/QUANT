import type { ExecutionContext } from "@odin/shared";
import type { Prisma } from "@odin/shared/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settlePendingOrder = vi.fn();
const releasePendingExitReservation = vi.fn();
const releaseInTx = vi.fn();

vi.mock("@odin/trading-engine", () => ({
  settlePendingOrder: (...args: unknown[]) => settlePendingOrder(...args),
  releasePendingExitReservation: (...args: unknown[]) => releasePendingExitReservation(...args),
}));
vi.mock("@odin/risk-engine", () => ({
  releaseInTx: (...args: unknown[]) => releaseInTx(...args),
}));

const { settlePendingPaperOrders } = await import("./settle.js");

const ctx = { accountId: "primary", tradingEnvironment: "MARKET_DATA_PAPER" } as unknown as ExecutionContext;
const now = new Date("2026-11-01T09:47:20.000Z");

function pendingSell(overrides: Record<string, unknown> = {}) {
  return {
    id: "ord_netclose",
    clientOrderId: "coid_netclose",
    accountId: "primary",
    pairAddress: "5E3dXLXGwmTDCokA51WYYaKttjFZBwqCoyUHBUi5gt2m",
    side: "SELL",
    intent: "EXIT",
    ownerScope: "NET_CLOSE",
    qty: { toString: () => "70488.51228139" },
    reasonCodes: ["ORDER_PROPOSED", "ORDER_PENDING"],
    ...overrides,
  };
}

function fakeTx(order: ReturnType<typeof pendingSell>, positionQty: string | null) {
  const update = vi.fn();
  const tx = {
    engineControl: { findUnique: vi.fn().mockResolvedValue({ status: "RUNNING", config: {} }) },
    order: { findMany: vi.fn().mockResolvedValue([order]), update },
    position: {
      findFirst: vi.fn().mockResolvedValue(positionQty === null ? null : { baseQty: { toString: () => positionQty } }),
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, update };
}

const host = {
  dataMode: "live",
  buildReservationBudget: vi.fn().mockResolvedValue({}),
  armProtectionForFill: vi.fn(),
} as unknown as Parameters<typeof settlePendingPaperOrders>[0];

describe("settle phase: exits superseded by another exit (ASCEND-00 F5)", () => {
  beforeEach(() => {
    settlePendingOrder.mockReset().mockResolvedValue({ status: "FILLED", side: "SELL", pairAddress: null });
    releasePendingExitReservation.mockReset();
    releaseInTx.mockReset();
  });

  it("cancels a pending NET_CLOSE when protection already closed the position, releasing its reservations", async () => {
    const order = pendingSell();
    const { tx, update } = fakeTx(order, "0");
    const filled = await settlePendingPaperOrders(host, tx, { ctx, now });
    expect(filled).toBe(0);
    expect(settlePendingOrder).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "ord_netclose" },
      data: {
        status: "CANCELLED",
        rejectReason: "EXIT_SUPERSEDED",
        reasonCodes: ["ORDER_PROPOSED", "ORDER_PENDING", "EXIT_SUPERSEDED"],
      },
    });
    expect(releasePendingExitReservation).toHaveBeenCalledWith(tx, order);
    expect(releaseInTx).toHaveBeenCalledWith(
      tx,
      { accountId: "primary", mode: "PAPER", clientOrderId: "coid_netclose" },
      {},
      now,
    );
  });

  it("cancels when no position row exists at all", async () => {
    const { tx, update } = fakeTx(pendingSell(), null);
    await settlePendingPaperOrders(host, tx, { ctx, now });
    expect(update).toHaveBeenCalledTimes(1);
    expect(settlePendingOrder).not.toHaveBeenCalled();
  });

  it("still settles a pending exit while the position is open", async () => {
    const { tx, update } = fakeTx(pendingSell(), "70488.51228139");
    const filled = await settlePendingPaperOrders(host, tx, { ctx, now });
    expect(filled).toBe(1);
    expect(settlePendingOrder).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it("does not apply to pending buys", async () => {
    settlePendingOrder.mockResolvedValue({ status: "FILLED", side: "BUY", pairAddress: null });
    const { tx, update } = fakeTx(pendingSell({ side: "BUY", intent: "ENTRY", ownerScope: "STRATEGY" }), null);
    await settlePendingPaperOrders(host, tx, { ctx, now });
    expect(settlePendingOrder).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });
});
