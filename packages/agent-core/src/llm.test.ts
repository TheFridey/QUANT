import { describe, expect, it } from "vitest";
import { MockModelProvider, OpenAiCompatibleProvider, advisoryReview, advisorySummarySchema } from "./llm.js";

describe("model provider", () => {
  it("returns a schema-valid mock advisory offline", async () => {
    const provider = new MockModelProvider();
    const result = await provider.completeJson(
      {
        model: "mock",
        purpose: "summarise",
        maxTokens: 100,
        timeoutMs: 1000,
        messages: [{ role: "user", content: "{}" }],
      },
      advisorySummarySchema,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.summary.length).toBeGreaterThan(0);
  });

  it("reports UNAVAILABLE without an API key", async () => {
    const provider = new OpenAiCompatibleProvider({ apiKey: undefined });
    const result = await provider.completeJson(
      {
        model: "gpt",
        purpose: "research",
        maxTokens: 100,
        timeoutMs: 1000,
        messages: [{ role: "user", content: "{}" }],
      },
      advisorySummarySchema,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNAVAILABLE");
  });

  it("keeps advisory text out of risk authority", async () => {
    const review = await advisoryReview(new MockModelProvider(), {
      agent: "ARCHIVIST",
      facts: { orders: 0, note: "no invented fills" },
    });
    expect(review.text).toContain("Advisory");
    expect(review.result.ok).toBe(true);
  });
});
