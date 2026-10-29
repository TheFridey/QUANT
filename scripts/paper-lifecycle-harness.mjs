#!/usr/bin/env node
/**
 * Local paper lifecycle harness (§34) — planCycle attributed intents without broker network.
 * Not Playwright. Not Gate 2. Proves Gate 1 planning path: instance ENTER → order proposal.
 *
 * Usage: pnpm build:packages && node scripts/paper-lifecycle-harness.mjs
 */
import { DEFAULT_STRATEGY } from "../packages/shared/dist/index.js";
import {
  allocateOpportunities,
  buildInstancePlanGates,
  evaluateConcurrentInstances,
  planCycle,
} from "../packages/agent-core/dist/index.js";

const fx = "fx:EURUSD";
const instances = [
  {
    id: "stratinst_harness_fx",
    name: "pulse-momentum-v1-fx",
    version: "1.0.0",
    accountId: "primary",
    instrumentIds: [fx],
    timeframe: "M5",
    params: {},
    budgetUsd: "10000",
    health: "HEALTHY",
    status: "ACTIVE",
    moduleRef: "pulse-momentum-v1",
    artifactHash: null,
    sourceHash: null,
  },
];

const pair = {
  source: "fixture",
  chainId: "fx",
  pairAddress: fx,
  dexId: null,
  url: null,
  baseAddress: "EUR",
  baseSymbol: "EUR",
  baseName: "Euro",
  quoteAddress: "USD",
  quoteSymbol: "USD",
  priceUsd: "1.08",
  liquidityUsd: "5000000",
  volume24hUsd: "100000000",
  volume5mUsd: "1000000",
  priceChangeM5Pct: "3",
  priceChangeH1Pct: "1.5",
  priceChangeH24Pct: null,
  txnsM5Buys: null,
  txnsM5Sells: null,
  observationId: "obs_harness",
  freshness: "LIVE",
  receivedAt: "2026-10-28T16:00:00.000Z",
};

const evaluated = evaluateConcurrentInstances({
  instances,
  bars: [
    {
      instrumentId: fx,
      pairAddress: fx,
      receivedAt: pair.receivedAt,
      priceUsd: pair.priceUsd,
      liquidityUsd: pair.liquidityUsd,
      volume24hUsd: pair.volume24hUsd,
      priceChangeM5Pct: pair.priceChangeM5Pct,
      priceChangeH1Pct: pair.priceChangeH1Pct,
      txnsM5Buys: null,
      txnsM5Sells: null,
      dataState: "LIVE",
    },
  ],
  context: { config: DEFAULT_STRATEGY, openPositions: [], history: [] },
});

const allocated = allocateOpportunities({ signals: evaluated.signals, maxNewEntries: 2 });
const gates = buildInstancePlanGates(allocated.accepted);
const plan = planCycle({
  cycleId: "cyc_harness",
  engineStatus: "RUNNING",
  config: DEFAULT_STRATEGY,
  cashUsd: DEFAULT_STRATEGY.startingBalanceUsd,
  startingBalanceUsd: DEFAULT_STRATEGY.startingBalanceUsd,
  positions: [],
  pairs: [pair],
  marks: { [fx]: { priceUsd: pair.priceUsd, freshness: "LIVE" } },
  dailyPnlUsd: "0",
  flatten: false,
  operator: null,
  highWaterMarkUsd: DEFAULT_STRATEGY.startingBalanceUsd,
  aggregateExposureUsd: "0",
  concurrentEntryAllowlist: gates.entryAllowlist,
  concurrentEntryByPair: gates.entryByPair,
  concurrentExitByPair: gates.exitByPair,
  concurrentInstanceByPair: gates.instanceByPair,
  now: new Date("2026-10-28T16:00:00.000Z"),
});

const buys = plan.orders.filter((o) => o.side === "BUY");
const ok = buys.length === 1 && buys[0].strategyInstanceId === "stratinst_harness_fx";
console.log(
  JSON.stringify(
    {
      ok,
      label: "local_paper_plan_harness",
      evaluationErrors: evaluated.errors,
      acceptedEnters: allocated.accepted.filter((s) => s.intent === "ENTER_LONG").length,
      orders: plan.orders.map((o) => ({
        side: o.side,
        intent: o.intent,
        strategyInstanceId: o.strategyInstanceId,
        clientOrderId: o.clientOrderId,
      })),
      note: "Plan-level paper lifecycle only — not worker/DB/browser E2E",
    },
    null,
    2,
  ),
);
process.exit(ok ? 0 : 1);
