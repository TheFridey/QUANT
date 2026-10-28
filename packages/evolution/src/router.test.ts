import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { advisorySummarySchema, type LlmRequest, type LlmResult, type ModelProvider } from "@odin/agent-core";
import { FixtureModelProvider } from "./fixture-provider.js";
import { ModelRouter, assertKnownTier, type ModelEndpoint } from "./router.js";

const liveEnabled = process.env.ODIN_LIVE_PROVIDER_TEST === "1" && Boolean(process.env.OPENAI_API_KEY);

describe("model router", () => {
  it("keeps four tiers and refuses to impersonate a model without credentials", async () => {
    expect([...assertKnownTier()]).toEqual([
      "FAST_OBSERVERS",
      "DEEP_RESEARCHERS",
      "ENGINEERING_AGENTS",
      "INDEPENDENT_CHALLENGE",
    ]);
    const secret = "sk-test-should-not-leak";
    const router = new ModelRouter({
      env: { OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", HERMES_API_KEY: "", ODIN_CHALLENGE_API_KEY: "" },
      mode: "live",
      budgetCapUsd: "1",
    });
    const health = router.health();
    expect(JSON.stringify(health)).not.toContain(secret);
    expect(health.find((row) => row.id === "openai-primary")?.availability).toBe("UNAVAILABLE");
    expect(health.find((row) => row.id === "fast-mock")?.availability).toBe("UNAVAILABLE");

    const result = await router.completeJson(
      "ORACLE",
      {
        purpose: "research",
        maxTokens: 200,
        timeoutMs: 1000,
        messages: [{ role: "user", content: "summarise" }],
      },
      advisorySummarySchema,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNAVAILABLE");
    expect(router.usage.some((row) => row.ok && (row.provenance === "MOCK" || row.provenance === "LIVE"))).toBe(false);
    expect(router.usage.every((row) => row.provenance === "UNAVAILABLE")).toBe(true);
    expect(JSON.stringify(router.usage)).not.toContain(secret);
  });

  it("labels explicit mock mode as MOCK and keeps the challenge endpoint independent", async () => {
    const router = new ModelRouter({ env: {}, mode: "mock", budgetCapUsd: "1" });
    const separated = router.assertSeparatedReviewer();
    expect(separated.separated).toBe(true);
    expect(separated.forgeEndpointId).toBe("anthropic-primary");
    expect(separated.challengeEndpointId).toBe("challenge-primary");
    const result = await router.completeJson(
      "ORACLE",
      {
        purpose: "research",
        maxTokens: 200,
        timeoutMs: 1000,
        messages: [{ role: "user", content: "summarise" }],
      },
      advisorySummarySchema,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.summary).toContain("MOCK");
    expect(result.usage?.provenance).toBe("MOCK");
    expect(result.usage?.costKind).toBe("ESTIMATED");
  });

  it("persists estimated spend across router instances and labels fixtures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odin-budget-"));
    const budgetPath = join(dir, "spend.json");
    const endpoint: ModelEndpoint = {
      id: "fast-mock",
      kind: "mock",
      tier: "FAST_OBSERVERS",
      model: "observer-fast",
      maxTokensDefault: 100,
      costPer1kInputUsd: "1",
      costPer1kOutputUsd: "1",
    };
    const first = new ModelRouter({
      mode: "mock",
      budgetPath,
      budgetCapUsd: "5",
      endpoints: [endpoint],
      assignments: [
        {
          agentOrTask: "ORACLE",
          tier: "FAST_OBSERVERS",
          primaryEndpointId: "fast-mock",
          fallbackEndpointIds: [],
        },
      ],
    });
    await first.completeJson(
      "ORACLE",
      { purpose: "summarise", maxTokens: 50, timeoutMs: 500, messages: [{ role: "user", content: "hello budget" }] },
      advisorySummarySchema,
    );
    expect(Number(first.budget().spentUsd)).toBeGreaterThan(0);
    const second = new ModelRouter({ mode: "mock", budgetPath, budgetCapUsd: "5", endpoints: [endpoint] });
    expect(second.budget().spentUsd).toBe(first.budget().spentUsd);

    const fixture = new FixtureModelProvider({
      research: { summary: "fixture note", tone: "neutral", bullets: [] },
    });
    const routed = new ModelRouter({
      mode: "live",
      env: {},
      providers: new Map([["openai-primary", fixture]]),
    });
    const result = await routed.completeJson(
      "ORACLE",
      { purpose: "research", maxTokens: 50, timeoutMs: 500, messages: [{ role: "user", content: "x" }] },
      advisorySummarySchema,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model).toBe("FIXTURE");
    expect(result.usage?.provenance).toBe("FIXTURE");
    expect(result.usage?.model).toBe("FIXTURE");
  });

  it("retries a timeout once before the next endpoint", async () => {
    let calls = 0;
    const flaky: ModelProvider = {
      id: "flaky-live",
      async completeJson<T>(_request: LlmRequest, schema: z.ZodType<T>): Promise<LlmResult<T>> {
        calls += 1;
        if (calls === 1) {
          return { ok: false, code: "TIMEOUT", error: "slow", provider: "flaky-live" };
        }
        const parsed = schema.parse({ summary: "second attempt", tone: "neutral", bullets: [] });
        return { ok: true, data: parsed, provider: "flaky-live", model: "configured", cached: false, latencyMs: 1 };
      },
    };
    const router = new ModelRouter({
      mode: "live",
      env: {},
      providers: new Map([["openai-primary", flaky]]),
    });
    const result = await router.completeJson(
      "ORACLE",
      { purpose: "research", maxTokens: 40, timeoutMs: 200, messages: [{ role: "user", content: "retry" }] },
      advisorySummarySchema,
    );
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.usage?.provenance).toBe("LIVE");
    expect(router.usage.filter((row) => row.endpointId === "openai-primary")).toHaveLength(2);
  });

  it.skipIf(!liveEnabled)("optional live provider call", async () => {
    const router = new ModelRouter({ env: process.env, mode: "live", budgetCapUsd: "0.05" });
    const result = await router.completeJson(
      "ORACLE",
      {
        purpose: "research",
        maxTokens: 80,
        timeoutMs: 20_000,
        messages: [{ role: "user", content: "Return JSON with summary, tone, bullets." }],
      },
      advisorySummarySchema,
    );
    expect(result.usage?.provenance).toBe("LIVE");
  });
});
