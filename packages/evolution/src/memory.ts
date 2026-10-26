import { z } from "zod";
import { tradeMemoryRecordSchema, type TradeMemoryPhase, type TradeMemoryRecord } from "@odin/shared";

export type TradeMemoryStore = {
  records: TradeMemoryRecord[];
};

export function createTradeMemoryStore(seed: TradeMemoryRecord[] = []): TradeMemoryStore {
  return { records: [...seed] };
}

export function appendTradeMemory(
  store: TradeMemoryStore,
  record: TradeMemoryRecord,
): TradeMemoryStore {
  const parsed = tradeMemoryRecordSchema.parse(record);
  if (parsed.phase === "AFTER") {
    parsed.postExit = true;
  }
  return { records: [...store.records, parsed] };
}

/**
 * Entry-time reconstruction may only use BEFORE + DURING (non-postExit) context.
 * AFTER / postExit records are excluded to prevent leakage into historical entry decisions.
 */
export function memoryForEntryDecision(
  store: TradeMemoryStore,
  tradeId: string,
): TradeMemoryRecord[] {
  return store.records.filter(
    (record) => record.tradeId === tradeId && !record.postExit && record.phase !== "AFTER",
  );
}

export const tradeMemoryQuerySchema = z
  .object({
    q: z.string().max(200).optional(),
    pairAddress: z.string().optional(),
    tradeId: z.string().optional(),
    phase: z.enum(["BEFORE", "DURING", "AFTER"]).optional(),
    includePostExit: z.boolean().default(true),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();

export type TradeMemoryQuery = z.infer<typeof tradeMemoryQuerySchema>;

export function searchTradeMemory(store: TradeMemoryStore, query: TradeMemoryQuery): TradeMemoryRecord[] {
  const parsed = tradeMemoryQuerySchema.parse(query);
  const needle = parsed.q?.toLowerCase();
  return store.records
    .filter((record) => {
      if (parsed.tradeId && record.tradeId !== parsed.tradeId) return false;
      if (parsed.pairAddress && record.pairAddress !== parsed.pairAddress) return false;
      if (parsed.phase && record.phase !== parsed.phase) return false;
      if (!parsed.includePostExit && record.postExit) return false;
      if (needle) {
        const blob = JSON.stringify(record.context).toLowerCase();
        if (!blob.includes(needle) && !record.tradeId.toLowerCase().includes(needle)) return false;
      }
      return true;
    })
    .slice(0, parsed.limit);
}

export function capturePhaseContext(input: {
  tradeId: string;
  pairAddress: string;
  phase: TradeMemoryPhase;
  context: Record<string, unknown>;
  at?: string;
}): TradeMemoryRecord {
  const postExit = input.phase === "AFTER";
  return tradeMemoryRecordSchema.parse({
    tradeId: input.tradeId,
    pairAddress: input.pairAddress,
    phase: input.phase,
    capturedAt: input.at ?? new Date().toISOString(),
    context: scrubFutureLeakage(input.context, postExit),
    postExit,
  });
}

function scrubFutureLeakage(context: Record<string, unknown>, postExit: boolean): Record<string, unknown> {
  if (postExit) return context;
  const copy = { ...context };
  delete copy.exitPrice;
  delete copy.realizedPnlUsd;
  delete copy.afterActionReview;
  return copy;
}
