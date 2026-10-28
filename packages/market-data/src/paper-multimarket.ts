import { SEED_INSTRUMENTS, canPaperExecute, type Instrument } from "@odin/shared";
import type { NormalizedPair } from "@odin/shared";

/** Deterministic DEMO fixture levels for paper multi-market ingest — never labelled LIVE. */
export const PAPER_FIXTURE_LEVELS: Record<string, string> = {
  "fx:EURUSD": "1.08500000",
  "fx:GBPUSD": "1.26500000",
  "etf:SPY": "520.25000000",
  "etf:QQQ": "445.75000000",
};

/**
 * Build NormalizedPair rows for enabled paper FX/ETF instruments.
 * Provenance is always DEMO via source fx_stub/etf_stub.
 */
export function buildPaperMultiMarketPairs(input: {
  instruments?: Instrument[];
  levels?: Record<string, string>;
  now?: Date;
}): NormalizedPair[] {
  const now = input.now ?? new Date();
  const levels = input.levels ?? PAPER_FIXTURE_LEVELS;
  const instruments = (input.instruments ?? SEED_INSTRUMENTS).filter(
    (item) =>
      canPaperExecute(item) &&
      (item.assetClass === "FX_SPOT" || item.assetClass === "EQUITY_ETF_PROXY") &&
      item.enabledByDefault,
  );
  return instruments.map((instrument) => {
    const level = levels[instrument.id] ?? null;
    const isFx = instrument.assetClass === "FX_SPOT";
    return {
      source: isFx ? ("fx_stub" as const) : ("etf_stub" as const),
      chainId: isFx ? ("fx" as const) : ("equity" as const),
      pairAddress: instrument.id,
      dexId: isFx ? "fx-paper" : "etf-paper",
      url: null,
      baseAddress: instrument.base,
      baseSymbol: instrument.symbol,
      baseName: instrument.displayName,
      quoteAddress: instrument.quote,
      quoteSymbol: instrument.quote,
      priceUsd: level,
      liquidityUsd: "50000000.00000000",
      volume24hUsd: "10000000.00000000",
      volume5mUsd: "100000.00000000",
      // Above default entryM5ChangePct (2) so DEMO paper paths can exercise entries.
      priceChangeM5Pct: "2.500000",
      priceChangeH1Pct: "1.000000",
      priceChangeH24Pct: "1.500000",
      txnsM5Buys: 10,
      txnsM5Sells: 4,
      pairCreatedAt: null,
      fdvUsd: null,
      marketCapUsd: null,
      raw: {
        provenance: "paper-multimarket-fixture",
        dataState: "DEMO",
        instrumentId: instrument.id,
        receivedAt: now.toISOString(),
        note: "DEMO stub — not a live venue quote",
      },
    };
  });
}
