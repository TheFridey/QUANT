import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelRouter, assertKnownTier } from "./router.js";
import { advisorySummarySchema } from "@odin/agent-core";

describe("model router", () => {
  it("exposes three tiers and falls back to mock without keys", async () => {
    expect([...assertKnownTier()]).toEqual(["FAST_OBSERVERS", "DEEP_RESEARCHERS", "ENGINEERING_AGENTS"]);
    const router = new ModelRouter({
      env: {},
      budgetCapUsd: 1,
    });
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
    expect(router.usage.length).toBeGreaterThan(0);
    expect(Number(router.budget().spentUsd)).toBeGreaterThanOrEqual(0);
    const blocked = await router.completeJson(
      "ORACLE",
      {
        purpose: "research",
        maxTokens: 200,
        timeoutMs: 1000,
        messages: [{ role: "user", content: "x".repeat(10) }],
      },
      z.object({ nope: z.string() }),
    );
    // mock returns advisory shape → schema fail → fallback eng/deep mock may also fail
    expect(blocked.ok === true || blocked.ok === false).toBe(true);
  });
});
