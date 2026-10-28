import { z } from "zod";
import { DATA_STATES } from "./freshness.js";
import { AGENT_NAMES } from "./market.js";
import { REASON_CODES } from "./reasons.js";

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/);
const nonNegDecimal = z.string().regex(/^\d+(\.\d+)?$/);

/** Runtime metadata attached to every agent decision. */
export const agentRuntimeMetaSchema = z
  .object({
    durationMs: z.number().nonnegative(),
    inputSource: z.string().min(1).max(128),
  })
  .strict();

export type AgentRuntimeMeta = z.infer<typeof agentRuntimeMetaSchema>;

export const discoveryFiltersSchema = z
  .object({
    minLiquidityUsd: nonNegDecimal.nullable(),
    minVolume24hUsd: nonNegDecimal.nullable(),
    maxPairAgeHours: z.number().positive().nullable(),
    minPairAgeMinutes: z.number().nonnegative().nullable(),
    requireTradableQuote: z.boolean(),
  })
  .strict();

export type DiscoveryFilters = z.infer<typeof discoveryFiltersSchema>;

export const discoveryCandidateSchema = z
  .object({
    pairAddress: z.string().min(1).max(128),
    baseAddress: z.string().min(1),
    baseSymbol: z.string().min(1),
    quoteAddress: z.string().min(1),
    quoteSymbol: z.string().min(1),
    dexId: z.string().min(1),
    source: z.enum(["dexscreener", "birdeye", "replay", "fx_stub", "etf_stub", "index_stub"]),
    priceUsd: decimalString.nullable(),
    liquidityUsd: decimalString.nullable(),
    volume24hUsd: decimalString.nullable(),
    volume5mUsd: decimalString.nullable(),
    marketCapUsd: decimalString.nullable(),
    fdvUsd: decimalString.nullable(),
    pairCreatedAt: z.string().datetime().nullable(),
    pairAgeMinutes: z.number().nonnegative().nullable(),
    txnsM5Buys: z.number().int().nullable(),
    txnsM5Sells: z.number().int().nullable(),
    priceChangeM5Pct: decimalString.nullable(),
    priceChangeH1Pct: decimalString.nullable(),
    freshness: z.enum(DATA_STATES),
    receivedAt: z.string().datetime(),
    discoveryScore: decimalString,
    rank: z.number().int().nonnegative(),
    reasonCodes: z.array(z.enum(REASON_CODES)),
  })
  .strict();

export type DiscoveryCandidate = z.infer<typeof discoveryCandidateSchema>;

export const watchlistEntrySchema = z
  .object({
    pairAddress: z.string().min(1).max(128),
    baseAddress: z.string().min(1),
    baseSymbol: z.string().min(1),
    score: decimalString,
    rank: z.number().int().nonnegative(),
    source: z.string().min(1),
    observedAt: z.string().datetime(),
    reasonCodes: z.array(z.enum(REASON_CODES)),
  })
  .strict();

export type WatchlistEntry = z.infer<typeof watchlistEntrySchema>;

export const pulseSignalSchema = z
  .object({
    pairAddress: z.string().min(1).max(128),
    score: decimalString.nullable(),
    confidence: decimalString,
    evidence: z.record(z.string(), z.unknown()),
    limitations: z.array(z.string()),
    reasonCodes: z.array(z.enum(REASON_CODES)),
    indicators: z
      .object({
        volumeAcceleration: decimalString.nullable(),
        relativeVolume: decimalString.nullable(),
        buySellImbalance: decimalString.nullable(),
        momentum: decimalString.nullable(),
        volatility: decimalString.nullable(),
        liquidityChange: decimalString.nullable(),
        priceVolumeDivergence: decimalString.nullable(),
        trendPersistence: decimalString.nullable(),
        manipulationWarning: z.boolean(),
      })
      .strict(),
    sampleSize: z.number().int().nonnegative(),
  })
  .strict();

export type PulseSignal = z.infer<typeof pulseSignalSchema>;

export const SECURITY_CATEGORIES = ["PASS", "REVIEW", "BLOCK", "UNKNOWN"] as const;
export type SecurityCategory = (typeof SECURITY_CATEGORIES)[number];

export const securityAssessmentSchema = z
  .object({
    tokenAddress: z.string().min(1),
    category: z.enum(SECURITY_CATEGORIES),
    confidence: decimalString,
    reasonCodes: z.array(z.enum(REASON_CODES)),
    mintAuthority: z.enum(["present", "revoked", "unknown"]),
    freezeAuthority: z.enum(["present", "revoked", "unknown"]),
    transferRestricted: z.boolean().nullable(),
    token2022Extensions: z.array(z.string()).nullable(),
    holderConcentrationTop10Pct: decimalString.nullable(),
    suspiciousDeployer: z.boolean().nullable(),
    liquidityFragile: z.boolean().nullable(),
    largeWalletMove: z.boolean().nullable(),
    fraudIndicators: z.array(z.string()),
    source: z.enum(["birdeye", "unavailable", "cached", "mock"]),
    fetchedAt: z.string().datetime().nullable(),
    stale: z.boolean(),
    fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  })
  .strict();

export type SecurityAssessment = z.infer<typeof securityAssessmentSchema>;

export const portfolioRiskLimitsSchema = z
  .object({
    maxRiskPerTradePct: nonNegDecimal,
    maxPositionPctEquity: nonNegDecimal,
    maxAggregateExposurePct: nonNegDecimal,
    maxDailyLossPct: nonNegDecimal,
    maxTotalDrawdownPct: nonNegDecimal,
    maxPositions: z.number().int().positive(),
    minLiquidityUsd: nonNegDecimal,
    maxPriceImpactBps: nonNegDecimal,
  })
  .strict();

export type PortfolioRiskLimits = z.infer<typeof portfolioRiskLimitsSchema>;

export const agentStatusRowSchema = z
  .object({
    agent: z.enum(AGENT_NAMES),
    decision: z.enum(["PASS", "REJECT", "HOLD", "ACT"]),
    confidence: decimalString,
    reasonCodes: z.array(z.enum(REASON_CODES)),
    inputSource: z.string(),
    durationMs: z.number().nonnegative().nullable(),
    outcome: z.string(),
    pairAddress: z.string().nullable(),
    modelVersion: z.string(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type AgentStatusRow = z.infer<typeof agentStatusRowSchema>;

export const observationPointSchema = z
  .object({
    receivedAt: z.string().datetime(),
    priceUsd: decimalString.nullable(),
    liquidityUsd: decimalString.nullable(),
    volume5mUsd: decimalString.nullable(),
    volume24hUsd: decimalString.nullable(),
    txnsM5Buys: z.number().int().nullable(),
    txnsM5Sells: z.number().int().nullable(),
    priceChangeM5Pct: decimalString.nullable(),
  })
  .strict();

export type ObservationPoint = z.infer<typeof observationPointSchema>;

export const researchProposalSchema = z
  .object({
    id: z.string().min(1),
    createdAt: z.string().datetime(),
    status: z.enum(["PROPOSED", "EVALUATED", "APPROVED", "REJECTED"]),
    parameterPatch: z.record(z.string(), z.unknown()),
    rationale: z.string(),
    walkForward: z
      .object({
        trainStart: z.string().datetime(),
        trainEnd: z.string().datetime(),
        testStart: z.string().datetime(),
        testEnd: z.string().datetime(),
        trainSampleSize: z.number().int().nonnegative(),
        testSampleSize: z.number().int().nonnegative(),
        metrics: z.record(z.string(), z.unknown()),
      })
      .nullable(),
    promoted: z.literal(false),
  })
  .strict();

export type ResearchProposal = z.infer<typeof researchProposalSchema>;
