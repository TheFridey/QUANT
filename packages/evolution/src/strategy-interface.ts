import { z } from "zod";
import type { StrategyConfig } from "@odin/shared";

/**
 * Typed Strategy contract for forged modules.
 * Strategies emit intents only — risk/sizing/fills stay in deterministic engines.
 */
export const strategySignalSchema = z
  .object({
    instrumentId: z.string().min(1),
    pairAddress: z.string().min(1).optional(),
    intent: z.enum(["ENTER_LONG", "EXIT_LONG", "HOLD"]),
    reasonCodes: z.array(z.string()).max(32),
    /** Advisory confidence only — never used as a size multiplier by risk code. */
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

export type StrategySignal = z.infer<typeof strategySignalSchema>;

export type StrategyBar = {
  instrumentId: string;
  pairAddress?: string;
  receivedAt: string;
  priceUsd: string | null;
  liquidityUsd: string | null;
  volume24hUsd: string | null;
  priceChangeM5Pct: string | null;
  priceChangeH1Pct: string | null;
  txnsM5Buys: number | null;
  txnsM5Sells: number | null;
  dataState: string;
};

export type StrategyContext = {
  config: StrategyConfig;
  openPositions: Array<{ instrumentId: string; pairAddress: string; qty: string }>;
  /** Bars available at decision time only — forge contract forbids future peeking. */
  history: StrategyBar[];
};

export interface StrategyModule {
  readonly id: string;
  readonly version: string;
  readonly instrumentIds: string[];
  onBar(bar: StrategyBar, context: StrategyContext): StrategySignal;
}

export const strategyModuleManifestSchema = z
  .object({
    id: z.string().min(1).max(80),
    version: z.string().min(1).max(40),
    instrumentIds: z.array(z.string()).min(1).max(32),
    hypothesisId: z.string().min(1).optional(),
    entrypoint: z.string().min(1).max(120),
  })
  .strict();

export type StrategyModuleManifest = z.infer<typeof strategyModuleManifestSchema>;
