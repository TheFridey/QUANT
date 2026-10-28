import { z } from "zod";
import type { LlmRequest, LlmResult, ModelProvider } from "@odin/agent-core";

/**
 * Explicit fixture provider for automated tests.
 * The model field is FIXTURE. It is not a frontier model.
 */
export class FixtureModelProvider implements ModelProvider {
  readonly id = "fixture";

  constructor(private readonly payloads: Record<string, unknown> = {}) {}

  async completeJson<T>(request: LlmRequest, schema: z.ZodType<T>): Promise<LlmResult<T>> {
    const started = Date.now();
    const raw = this.payloads[request.purpose] ?? this.payloads.default;
    if (raw === undefined) {
      return { ok: false, code: "UNAVAILABLE", error: "Fixture has no payload for this purpose", provider: this.id };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, code: "INVALID", error: "Fixture payload failed schema validation", provider: this.id };
    }
    return {
      ok: true,
      data: parsed.data,
      provider: this.id,
      model: "FIXTURE",
      cached: false,
      latencyMs: Date.now() - started,
    };
  }
}
