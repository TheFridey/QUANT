import { z } from "zod";

export const ASSET_CLASSES = [
  "SPOT_CRYPTO_PAIR",
  "FX_SPOT",
  "EQUITY_INDEX",
  "EQUITY_ETF_PROXY",
  "FUTURES_PROXY",
  "COMMODITY_PROXY",
] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const VENUES = ["SOLANA_DEX", "INDEX_REFERENCE", "FX_REFERENCE", "PAPER", "EXTERNAL_DEMO"] as const;
export type Venue = (typeof VENUES)[number];

export const MARKET_PROVIDER_IDS = [
  "dexscreener",
  "birdeye",
  "index_stub",
  "index_yahoo_delayed",
  "fx_stub",
  "commodity_stub",
  "external_demo",
  "frankfurter_fx",
  "alpaca_paper",
  "oanda_practice",
] as const;
export type MarketProviderId = (typeof MARKET_PROVIDER_IDS)[number];

export const EXECUTION_CAPABILITIES = [
  "PAPER_SPOT",
  "PAPER_FX",
  "RESEARCH_ONLY",
  "NO_EXECUTION",
  "EXTERNAL_DEMO",
] as const;
export type ExecutionCapability = (typeof EXECUTION_CAPABILITIES)[number];

export const SESSION_KINDS = ["CRYPTO_24x7", "INDEX_RTH", "INDEX_EXTENDED", "FX_WEEKDAY"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export const instrumentSchema = z
  .object({
    id: z.string().min(1).max(64),
    symbol: z.string().min(1).max(32),
    displayName: z.string().min(1).max(120),
    venue: z.enum(VENUES),
    assetClass: z.enum(ASSET_CLASSES),
    base: z.string().min(1).max(32),
    quote: z.string().min(1).max(32),
    tickSize: z.string().regex(/^\d+(\.\d+)?$/),
    lotSize: z.string().regex(/^\d+(\.\d+)?$/),
    session: z.enum(SESSION_KINDS),
    providerId: z.enum(MARKET_PROVIDER_IDS),
    providerSymbol: z.string().min(1).max(128),
    executionCapabilities: z.array(z.enum(EXECUTION_CAPABILITIES)).min(1),
    enabledByDefault: z.boolean(),
    notes: z.string().max(500).optional(),
  })
  .strict();

export type Instrument = z.infer<typeof instrumentSchema>;

export const marketSelectionSchema = z
  .object({
    instrumentId: z.string().min(1),
    enabled: z.boolean(),
  })
  .strict();

export type MarketSelection = z.infer<typeof marketSelectionSchema>;

/** Seed registry: Solana + FX pairs + equity indices (research) + ETF proxies (paper). */
export const SEED_INSTRUMENTS: Instrument[] = [
  {
    id: "solana:spot:universe",
    symbol: "SOL-UNIVERSE",
    displayName: "Solana DEX universe (DexScreener)",
    venue: "SOLANA_DEX",
    assetClass: "SPOT_CRYPTO_PAIR",
    base: "BASE",
    quote: "QUOTE",
    tickSize: "0.00000001",
    lotSize: "0.00000001",
    session: "CRYPTO_24x7",
    providerId: "dexscreener",
    providerSymbol: "solana:*",
    executionCapabilities: ["PAPER_SPOT"],
    enabledByDefault: true,
    notes: "Live paper path. Pair addresses discovered at ingest time.",
  },
  {
    id: "fx:EURUSD",
    symbol: "EURUSD",
    displayName: "Euro / US Dollar",
    venue: "FX_REFERENCE",
    assetClass: "FX_SPOT",
    base: "EUR",
    quote: "USD",
    tickSize: "0.00001",
    lotSize: "0.01",
    session: "FX_WEEKDAY",
    providerId: "fx_stub",
    providerSymbol: "EURUSD",
    executionCapabilities: ["PAPER_FX"],
    enabledByDefault: true,
    notes: "Currency pair. Internal paper FX; live feed may be BLOCKED_EXTERNAL.",
  },
  {
    id: "fx:GBPUSD",
    symbol: "GBPUSD",
    displayName: "British Pound / US Dollar",
    venue: "FX_REFERENCE",
    assetClass: "FX_SPOT",
    base: "GBP",
    quote: "USD",
    tickSize: "0.00001",
    lotSize: "0.01",
    session: "FX_WEEKDAY",
    providerId: "fx_stub",
    providerSymbol: "GBPUSD",
    executionCapabilities: ["PAPER_FX"],
    enabledByDefault: true,
    notes: "Currency pair for multi-market paper.",
  },
  {
    id: "fx:USDJPY",
    symbol: "USDJPY",
    displayName: "US Dollar / Japanese Yen",
    venue: "FX_REFERENCE",
    assetClass: "FX_SPOT",
    base: "USD",
    quote: "JPY",
    tickSize: "0.001",
    lotSize: "0.01",
    session: "FX_WEEKDAY",
    providerId: "fx_stub",
    providerSymbol: "USDJPY",
    executionCapabilities: ["PAPER_FX"],
    enabledByDefault: false,
    notes: "Quote is JPY — convert via FX helper before USD risk accounting.",
  },
  {
    id: "etf:SPY",
    symbol: "SPY",
    displayName: "SPDR S&P 500 ETF Trust",
    venue: "PAPER",
    assetClass: "EQUITY_ETF_PROXY",
    base: "SPY",
    quote: "USD",
    tickSize: "0.01",
    lotSize: "0.001",
    session: "INDEX_RTH",
    providerId: "index_yahoo_delayed",
    providerSymbol: "SPY",
    executionCapabilities: ["PAPER_SPOT"],
    enabledByDefault: true,
    notes: "Executable ETF proxy for S&P 500 exposure. Not the index level.",
  },
  {
    id: "etf:QQQ",
    symbol: "QQQ",
    displayName: "Invesco QQQ Trust",
    venue: "PAPER",
    assetClass: "EQUITY_ETF_PROXY",
    base: "QQQ",
    quote: "USD",
    tickSize: "0.01",
    lotSize: "0.001",
    session: "INDEX_RTH",
    providerId: "index_yahoo_delayed",
    providerSymbol: "QQQ",
    executionCapabilities: ["PAPER_SPOT"],
    enabledByDefault: true,
    notes: "Executable Nasdaq-100 ETF proxy. Not NDX.",
  },
  {
    id: "index:SPX",
    symbol: "SPX",
    displayName: "S&P 500 Index",
    venue: "INDEX_REFERENCE",
    assetClass: "EQUITY_INDEX",
    base: "SPX",
    quote: "USD",
    tickSize: "0.01",
    lotSize: "1",
    session: "INDEX_RTH",
    providerId: "index_stub",
    providerSymbol: "^GSPC",
    executionCapabilities: ["RESEARCH_ONLY", "NO_EXECUTION"],
    enabledByDefault: false,
    notes: "Index level — not a tradable ETF/future. No paper fills.",
  },
  {
    id: "index:NDX",
    symbol: "NDX",
    displayName: "Nasdaq-100 Index",
    venue: "INDEX_REFERENCE",
    assetClass: "EQUITY_INDEX",
    base: "NDX",
    quote: "USD",
    tickSize: "0.01",
    lotSize: "1",
    session: "INDEX_RTH",
    providerId: "index_stub",
    providerSymbol: "^NDX",
    executionCapabilities: ["RESEARCH_ONLY", "NO_EXECUTION"],
    enabledByDefault: false,
    notes: "Index level — not QQQ. No paper fills.",
  },
  {
    id: "index:FTSE",
    symbol: "FTSE",
    displayName: "FTSE 100 Index",
    venue: "INDEX_REFERENCE",
    assetClass: "EQUITY_INDEX",
    base: "UKX",
    quote: "GBP",
    tickSize: "0.01",
    lotSize: "1",
    session: "INDEX_RTH",
    providerId: "index_stub",
    providerSymbol: "^FTSE",
    executionCapabilities: ["RESEARCH_ONLY", "NO_EXECUTION"],
    enabledByDefault: false,
    notes: "Index level — not an ETF proxy. No paper fills.",
  },
  {
    id: "index:DJI",
    symbol: "DJI",
    displayName: "Dow Jones Industrial Average",
    venue: "INDEX_REFERENCE",
    assetClass: "EQUITY_INDEX",
    base: "DJI",
    quote: "USD",
    tickSize: "0.01",
    lotSize: "1",
    session: "INDEX_RTH",
    providerId: "index_stub",
    providerSymbol: "^DJI",
    executionCapabilities: ["RESEARCH_ONLY", "NO_EXECUTION"],
    enabledByDefault: false,
    notes: "Index level — not DIA. No paper fills.",
  },
  {
    id: "commodity:XAUUSD",
    symbol: "XAUUSD",
    displayName: "Gold / US Dollar (paper proxy)",
    venue: "PAPER",
    assetClass: "COMMODITY_PROXY",
    base: "XAU",
    quote: "USD",
    tickSize: "0.01",
    lotSize: "0.001",
    session: "FX_WEEKDAY",
    providerId: "commodity_stub",
    providerSymbol: "XAUUSD",
    executionCapabilities: ["PAPER_SPOT"],
    enabledByDefault: true,
    notes: "DEMO paper commodity proxy — not a live metals venue.",
  },
  {
    id: "commodity:WTI",
    symbol: "WTI",
    displayName: "WTI Crude Oil (paper proxy)",
    venue: "PAPER",
    assetClass: "COMMODITY_PROXY",
    base: "WTI",
    quote: "USD",
    tickSize: "0.01",
    lotSize: "0.001",
    session: "INDEX_EXTENDED",
    providerId: "commodity_stub",
    providerSymbol: "CL",
    executionCapabilities: ["PAPER_SPOT"],
    enabledByDefault: true,
    notes: "DEMO paper commodity proxy — not a live futures venue.",
  },
];

/** Asset classes that may share a single strategy module. */
const COMPATIBLE_GROUPS: AssetClass[][] = [
  ["SPOT_CRYPTO_PAIR"],
  ["FX_SPOT"],
  ["EQUITY_INDEX"],
  ["EQUITY_ETF_PROXY", "FUTURES_PROXY", "COMMODITY_PROXY"],
];

export function assertCompatibleInstruments(instruments: Instrument[]): {
  ok: boolean;
  reason?: string;
} {
  if (instruments.length === 0) {
    return { ok: false, reason: "No instruments selected" };
  }
  const classes = new Set(instruments.map((item) => item.assetClass));
  for (const group of COMPATIBLE_GROUPS) {
    if ([...classes].every((assetClass) => (group as readonly AssetClass[]).includes(assetClass))) {
      return { ok: true };
    }
  }
  return {
    ok: false,
    reason: `Incompatible instrument mix: ${[...classes].join(", ")}. Strategies cannot mix crypto spot with equity indices or FX without an explicit multi-asset allocator.`,
  };
}

export function canPaperExecute(instrument: Instrument): boolean {
  return (
    instrument.executionCapabilities.includes("PAPER_SPOT") ||
    instrument.executionCapabilities.includes("PAPER_FX")
  );
}

export function isResearchOnly(instrument: Instrument): boolean {
  return (
    instrument.executionCapabilities.includes("RESEARCH_ONLY") ||
    instrument.executionCapabilities.includes("NO_EXECUTION") ||
    instrument.assetClass === "EQUITY_INDEX"
  );
}

export function findInstrument(id: string): Instrument | undefined {
  return SEED_INSTRUMENTS.find((item) => item.id === id);
}
