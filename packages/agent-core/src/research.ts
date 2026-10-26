import {
  parseStrategyConfig,
  type ResearchProposal,
  type StrategyConfig,
} from "@odin/shared";
import { performanceReport, valuePortfolio, type Mark } from "@odin/analytics";

export type WalkForwardWindow = {
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
};

export type ClosedTradeSample = {
  closedAt: string;
  pnlUsd: string;
};

export type ResearchLoopInput = {
  id: string;
  createdAt: string;
  baseline: StrategyConfig;
  parameterPatch: Partial<StrategyConfig>;
  rationale: string;
  window: WalkForwardWindow;
  trainTrades: ClosedTradeSample[];
  testTrades: ClosedTradeSample[];
  cashUsd: string;
  startingBalanceUsd: string;
  positions?: Array<{
    pairAddress: string;
    baseSymbol: string;
    baseQty: string;
    avgCostUsd: string;
    realizedPnlUsd: string;
  }>;
  marks?: Record<string, Mark | undefined>;
};

/**
 * Offline walk-forward research loop.
 * Produces proposals and metrics only — never mutates a RUNNING engine config.
 */
export function runWalkForward(input: ResearchLoopInput): ResearchProposal {
  const merged = parseStrategyConfig({ ...input.baseline, ...input.parameterPatch });
  const trainMetrics = scoreWindow(input.trainTrades, input);
  const testMetrics = scoreWindow(input.testTrades, input);

  return {
    id: input.id,
    createdAt: input.createdAt,
    status: "EVALUATED",
    parameterPatch: input.parameterPatch as Record<string, unknown>,
    rationale: input.rationale,
    walkForward: {
      trainStart: input.window.trainStart,
      trainEnd: input.window.trainEnd,
      testStart: input.window.testStart,
      testEnd: input.window.testEnd,
      trainSampleSize: input.trainTrades.length,
      testSampleSize: input.testTrades.length,
      metrics: {
        train: trainMetrics,
        test: testMetrics,
        mergedStopLossPct: merged.stopLossPct,
        mergedMaxRiskPerTradePct: merged.maxRiskPerTradePct,
        observed: true,
        estimate: false,
      },
    },
    promoted: false,
  };
}

/** Explicit promotion approval. Does not apply the patch — caller must persist APPROVED and wait for operator. */
export function approveResearchProposal(proposal: ResearchProposal, approvedAt: string): ResearchProposal {
  if (proposal.promoted) return proposal;
  return {
    ...proposal,
    status: "APPROVED",
    // promoted stays false until an operator applies outside the RUNNING path
    promoted: false,
    walkForward: proposal.walkForward
      ? {
          ...proposal.walkForward,
          metrics: { ...proposal.walkForward.metrics, approvedAt },
        }
      : null,
  };
}

export function rejectResearchProposal(proposal: ResearchProposal): ResearchProposal {
  return { ...proposal, status: "REJECTED", promoted: false };
}

function scoreWindow(trades: ClosedTradeSample[], input: ResearchLoopInput) {
  const valuation = valuePortfolio({
    cashUsd: input.cashUsd,
    positions: input.positions ?? [],
    marks: input.marks ?? {},
  });
  const report = performanceReport({
    valuation,
    startingBalanceUsd: input.startingBalanceUsd,
    feesUsd: "0.00000000",
    closedTradePnlUsd: trades.map((trade) => trade.pnlUsd),
  });
  return {
    sampleSize: trades.length,
    winRate: report.winRate,
    wins: report.wins,
    losses: report.losses,
    returnPct: report.returnPct,
    observed: true,
  };
}
