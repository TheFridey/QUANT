import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_AUTONOMY, DEFAULT_STRATEGY, autonomyPolicySchema, type Hypothesis, type StrategyConfig } from "@odin/shared";
import type { BacktestObservation } from "@odin/backtest";
import { featuresForEntry, reconstructTrade } from "./archivist.js";
import { FixtureModelProvider } from "./fixture-provider.js";
import { forgeStrategyModule } from "./forge.js";
import { appendTradeMemory, capturePhaseContext, createTradeMemoryStore } from "./memory.js";
import { runBoundedResearchCycle } from "./oracle-cycle.js";
import { labelAsAiDiscovery, proposeOracleCycle } from "./oracle-research.js";
import { reviewPromotion } from "./promotion.js";
import { runResearchPipeline } from "./pipeline.js";
import { simulateResearchPath } from "./research-backtest.js";
import { isolationAvailable } from "./sandbox-runner.js";
import { ModelRouter } from "./router.js";
import { verifyExperimentReport } from "./validate.js";
import { advisorySummarySchema } from "@odin/agent-core";

const hypothesis: Hypothesis = {
  id: "hyp_accept",
  title: "Acceptance continuation",
  market: "SPOT_CRYPTO_PAIR",
  instrumentIds: ["solana:spot:universe"],
  conditions: "LIVE liquid Solana pairs",
  claimedAdvantage: "M5 continuation",
  entryRules: "band entry",
  exitRules: "stop/tp/fade",
  riskRules: "atlas",
  rationale: "acceptance fixture",
  successCriteria: "oos evidence",
  failureModes: "regime",
  status: "OPEN",
};

const holdSource = `export function onBar() {
  return { intent: "HOLD", reasonCodes: ["FIXTURE_HOLD"], state: {} };
}`;

const enterSource = `export function onBar(input) {
  const past = input.history.length;
  return { intent: past > 0 ? "ENTER_LONG" : "HOLD", reasonCodes: ["FIXTURE_ENTER", String(past)], state: {} };
}`;

const config: StrategyConfig = {
  ...DEFAULT_STRATEGY,
  paperLatencyMs: 0,
  minLiquidityUsd: "100",
  maxSlippageBps: "500",
  maxPriceImpactBps: "500",
  minOrderNotionalUsd: "1",
  maxPositionPctEquity: "20",
  maxParticipationPctLiquidity: "20",
  feeBps: "30",
};

function obs(id: string, receivedAt: string, priceUsd: string | null, freshness: BacktestObservation["freshness"] = "LIVE"): BacktestObservation {
  return {
    id,
    pairAddress: "pair-a",
    baseSymbol: "AAA",
    quoteAddress: "quote",
    quoteSymbol: "USDC",
    priceUsd,
    liquidityUsd: "100000",
    volume24hUsd: "100000",
    volume5mUsd: "1000",
    priceChangeM5Pct: "1",
    priceChangeH1Pct: "1",
    txnsM5Buys: 3,
    txnsM5Sells: 1,
    receivedAt,
    freshness,
    provenance: "fixture:acceptance",
  };
}

describe("project genesis acceptance", () => {
  it("runs a fixture-labelled source through forge, risk, validation, and oracle follow-up", async () => {
    const fixture = new FixtureModelProvider({
      research: { summary: "fixture engineering note", tone: "neutral", bullets: ["source is supplied by the test"] },
    });
    const router = new ModelRouter({
      mode: "live",
      env: {},
      providers: new Map([["anthropic-primary", fixture]]),
    });
    const engineered = await router.completeJson(
      "FORGE",
      { purpose: "research", maxTokens: 80, timeoutMs: 500, messages: [{ role: "user", content: "generate" }] },
      advisorySummarySchema,
    );
    expect(engineered.ok).toBe(true);
    expect(engineered.usage?.provenance).toBe("FIXTURE");
    expect(engineered.usage?.model).toBe("FIXTURE");

    const hold = await forgeStrategyModule({
      hypothesis,
      source: holdSource,
      modelIdentifier: "FIXTURE",
      bars: [
        {
          instrumentId: "solana:spot:universe",
          pairAddress: "pair-a",
          receivedAt: "2026-01-01T00:00:00.000Z",
          priceUsd: "1",
          liquidityUsd: "100000",
          volume24hUsd: "1000",
          priceChangeM5Pct: "1",
          priceChangeH1Pct: "1",
          txnsM5Buys: 2,
          txnsM5Sells: 1,
          dataState: "LIVE",
        },
      ],
    });
    const enter = await forgeStrategyModule({
      hypothesis,
      source: enterSource,
      modelIdentifier: "FIXTURE",
      bars: [
        {
          instrumentId: "solana:spot:universe",
          pairAddress: "pair-a",
          receivedAt: "2026-01-01T00:00:00.000Z",
          priceUsd: "1",
          liquidityUsd: "100000",
          volume24hUsd: "1000",
          priceChangeM5Pct: "1",
          priceChangeH1Pct: "1",
          txnsM5Buys: 2,
          txnsM5Sells: 1,
          dataState: "LIVE",
        },
        {
          instrumentId: "solana:spot:universe",
          pairAddress: "pair-a",
          receivedAt: "2026-01-01T00:01:00.000Z",
          priceUsd: "1.1",
          liquidityUsd: "100000",
          volume24hUsd: "1000",
          priceChangeM5Pct: "1",
          priceChangeH1Pct: "1",
          txnsM5Buys: 2,
          txnsM5Sells: 1,
          dataState: "LIVE",
        },
      ],
    });
    if (!isolationAvailable()) {
      expect(hold.signalsClaimed).toBe(false);
      expect(enter.signalsClaimed).toBe(false);
    } else {
      expect(hold.ok).toBe(true);
      expect(enter.ok).toBe(true);
      if (hold.ok && enter.ok) {
        expect(hold.signals[0]?.intent).toBe("HOLD");
        expect(enter.signals.some((signal) => signal.intent === "ENTER_LONG")).toBe(true);
        expect(hold.sourceHash).not.toBe(enter.sourceHash);
        expect(hold.integrity.compiledArtifactHash).toBeTruthy();
      }
    }

    const pipeline = await runResearchPipeline({ hypothesis, autonomy: DEFAULT_AUTONOMY, router });
    expect(pipeline.outcomes.PIPELINE_COMPLETED.met).toBe(true);
    expect(pipeline.outcomes.RESULTS_MEASURABLE.met).toBe(false);
    expect(pipeline.returnPct).toBeNull();
    expect(pipeline.report).not.toBeNull();
    if (pipeline.report) expect(verifyExperimentReport(pipeline.report)).toBe(true);
    expect(pipeline.acceptance.subsequent_experiment_proposed).toBe("PASS");
    expect(pipeline.oracle.queue.length).toBeGreaterThan(0);
    const separated = router.assertSeparatedReviewer();
    expect(separated.separated).toBe(true);
    expect(separated.forgeEndpointId).not.toBe(separated.challengeEndpointId);
  });

  it("refuses invented results, impersonation, risk bypass, credential reads, and paper-engine promotion", async () => {
    const missing = simulateResearchPath({
      observations: [obs("a", "2026-01-01T00:00:00.000Z", null), obs("b", "2026-01-01T00:01:00.000Z", null)],
      signals: [
        { observationId: "a", intent: "ENTER_LONG" },
        { observationId: "b", intent: "ENTER_LONG" },
      ],
      config,
      initialCashUsd: "1000",
      latencyMs: 0,
    });
    expect(missing.fills).toHaveLength(0);
    expect(missing.returnPct).toBeNull();

    const demo = simulateResearchPath({
      observations: [
        obs("a", "2026-01-01T00:00:00.000Z", "1", "DEMO"),
        obs("b", "2026-01-01T00:01:00.000Z", "1.1", "DEMO"),
      ],
      signals: [{ observationId: "a", intent: "ENTER_LONG" }],
      config,
      initialCashUsd: "1000",
      latencyMs: 0,
    });
    expect(demo.fills).toHaveLength(0);
    expect(demo.rejected.some((row) => row.reason.includes("DATA_DEMO") || row.reason.length > 0) || demo.blocked).toBe(true);

    const unconfigured = new ModelRouter({ mode: "live", env: {} });
    const impersonation = await unconfigured.completeJson(
      "ORACLE",
      { purpose: "research", maxTokens: 40, timeoutMs: 500, messages: [{ role: "user", content: "act as a model" }] },
      advisorySummarySchema,
    );
    expect(impersonation.ok).toBe(false);
    expect(unconfigured.usage.some((row) => row.ok)).toBe(false);
    expect(labelAsAiDiscovery({ provenance: "MODEL", modelIdentifier: "UNAVAILABLE" })).toBe(false);

    process.env.ODIN_CANARY_SECRET = "CANARY_NOT_A_KEY";
    const sneaky = await forgeStrategyModule({
      hypothesis,
      modelIdentifier: "FIXTURE",
      source: `export async function onBar() {
        const holder = globalThis["pro" + "cess"];
        const secret = holder && holder.env ? holder.env.ODIN_CANARY_SECRET : "ABSENT";
        return { intent: "HOLD", reasonCodes: ["SECRET_" + String(secret || "ABSENT")], state: {} };
      }`,
    });
    delete process.env.ODIN_CANARY_SECRET;
    expect(JSON.stringify(sneaky)).not.toContain("CANARY_NOT_A_KEY");
    if (sneaky.ok) {
      expect(sneaky.signals.every((signal) => signal.reasonCodes.every((code) => !code.includes("CANARY_NOT_A_KEY")))).toBe(true);
    } else {
      expect(sneaky.signalsClaimed).toBe(false);
    }

    expect(reviewPromotion({ deploymentEligible: false, approvalStatus: "PENDING", reviewed: false }).appliedToPaperEngine).toBe(false);
    expect(reviewPromotion({ deploymentEligible: true, approvalStatus: "APPROVED", reviewed: true }).appliedToPaperEngine).toBe(false);
    expect(autonomyPolicySchema.safeParse({ ...DEFAULT_AUTONOMY, realMoneyExecutionEnabled: true }).success).toBe(false);
    expect(autonomyPolicySchema.safeParse({ ...DEFAULT_AUTONOMY, allowUnreviewedCodeDeploy: true }).success).toBe(false);

    const terminal = readFileSync(new URL("../../../apps/api/src/terminal.service.ts", import.meta.url), "utf8");
    expect(terminal).toContain("Paper orders are accepted only while the engine is running");
    expect(terminal).not.toMatch(/api\.binance|jup\.ag\/swap|submitLiveOrder|placeRealOrder/);

    const proposals = proposeOracleCycle({
      performance: { returnPct: null, sampleSize: 0, maxDrawdownPct: null },
      memory: [],
      challengePassed: null,
      challengeFindings: [],
      baselines: [],
      hypothesisId: hypothesis.id ?? null,
      openConditions: [],
    });
    expect(proposals.find((row) => row.capability === "REVIEW_PERFORMANCE")?.returnPct).toBeNull();
    expect(proposals.every((row) => row.aiDiscovery === false)).toBe(true);

    let store = createTradeMemoryStore();
    store = appendTradeMemory(
      store,
      capturePhaseContext({
        tradeId: "accept-1",
        pairAddress: "pair-a",
        phase: "BEFORE",
        at: "2026-01-01T00:00:00.000Z",
        context: { entryHypothesis: "continuation", strategyVersion: "0.1.0" },
      }),
    );
    store = appendTradeMemory(
      store,
      capturePhaseContext({
        tradeId: "accept-1",
        pairAddress: "pair-a",
        phase: "AFTER",
        at: "2026-01-01T00:05:00.000Z",
        context: { netPnlUsd: "2", exitRationale: "target" },
      }),
    );
    const reconstruction = reconstructTrade(store.records);
    expect(reconstruction?.before?.entryHypothesis).toBe("continuation");
    expect(reconstruction?.after?.netPnlUsd).toBe("2");
    expect(featuresForEntry(store, "accept-1").features.netPnlUsd).toBeUndefined();
  });

  it.skipIf(!isolationAvailable())(
    "drives one bounded cycle from a fixture and changes signals when only the decision logic changes",
    async () => {
    const fixtureFor = (source: string) => {
      const fixture = new FixtureModelProvider({
        fast_observer: { weaknesses: ["thin follow-through"] },
        deep_hypothesis: {
          title: "M5 continuation fails out of sample",
          falsifier: "Untouched window return is null or negative",
          conditions: "m5 thrust continues for one bar",
        },
        engineering_source: { source },
        challenge_review: { verdict: "REJECT", findings: ["SAMPLE_SIZE"] },
      });
      return new ModelRouter({
        providers: new Map([
          ["hermes-primary", fixture],
          ["openai-primary", fixture],
          ["anthropic-primary", fixture],
          ["challenge-primary", fixture],
        ]),
        mode: "live",
        env: {},
        budgetCapUsd: "5",
      });
    };
    const inputFor = (router: ModelRouter) => ({
      router,
      performance: { returnPct: null, sampleSize: 0, maxDrawdownPct: null },
      memory: [],
      baselines: [{ id: "baseline", returnPct: "0.10", sampleSize: 40 }],
      hypothesisId: hypothesis.id ?? "hyp_accept",
      instrumentIds: hypothesis.instrumentIds,
      bars: [
        {
          instrumentId: hypothesis.instrumentIds[0] ?? "solana:spot:universe",
          receivedAt: "2026-01-01T00:00:00.000Z",
          priceUsd: "1",
          liquidityUsd: "100000",
          volume24hUsd: "100000",
          priceChangeM5Pct: "1",
          priceChangeH1Pct: "1",
          txnsM5Buys: 3,
          txnsM5Sells: 1,
          dataState: "REPLAY",
        },
        {
          instrumentId: hypothesis.instrumentIds[0] ?? "solana:spot:universe",
          receivedAt: "2026-01-01T00:05:00.000Z",
          priceUsd: "1.01",
          liquidityUsd: "100000",
          volume24hUsd: "100000",
          priceChangeM5Pct: "1",
          priceChangeH1Pct: "1",
          txnsM5Buys: 3,
          txnsM5Sells: 1,
          dataState: "REPLAY",
        },
      ],
    });
    const hold = await runBoundedResearchCycle(inputFor(fixtureFor(holdSource)));
    const enter = await runBoundedResearchCycle(inputFor(fixtureFor(enterSource)));
    expect(hold.steps).toHaveLength(13);
    expect(hold.signals.map((signal) => signal.intent)).not.toEqual(enter.signals.map((signal) => signal.intent));
    expect(hold.steps.find((step) => step.capability === "RECOMMEND_EXPERIMENT")?.status).toBe("RECORDED");
    expect(hold.aiDiscoveryStored).toBe(false);
    expect(hold.routerUsage.filter((row) => row.ok).every((row) => row.provenance === "FIXTURE" && row.costKind === "ESTIMATED")).toBe(true);
  });
});
