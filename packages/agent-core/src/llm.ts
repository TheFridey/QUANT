import { z } from "zod";

export const advisorySummarySchema = z
  .object({
    summary: z.string().min(1).max(2000),
    tone: z.enum(["neutral", "caution", "constructive"]),
    bullets: z.array(z.string().max(240)).max(8),
  })
  .strict();

export type AdvisorySummary = z.infer<typeof advisorySummarySchema>;

export type LlmMessage = { role: "system" | "user" | "assistant"; content: string };

export type LlmRequest = {
  model: string;
  messages: LlmMessage[];
  maxTokens: number;
  timeoutMs: number;
  purpose: "classify" | "summarise" | "research" | "post_trade";
};

export type LlmResult<T> =
  | { ok: true; data: T; provider: string; model: string; cached: boolean; latencyMs: number }
  | { ok: false; code: "UNAVAILABLE" | "TIMEOUT" | "INVALID" | "UPSTREAM"; error: string; provider: string };

export interface ModelProvider {
  readonly id: string;
  completeJson<T>(request: LlmRequest, schema: z.ZodType<T>): Promise<LlmResult<T>>;
}

/** Offline mock — never invents market facts; returns a static advisory shell. */
export class MockModelProvider implements ModelProvider {
  readonly id = "mock";

  async completeJson<T>(request: LlmRequest, schema: z.ZodType<T>): Promise<LlmResult<T>> {
    const started = Date.now();
    if (request.purpose === "summarise" || request.purpose === "post_trade" || request.purpose === "research") {
      const draft = {
        summary: "Advisory-only review. Deterministic risk and sizing remain authoritative.",
        tone: "neutral" as const,
        bullets: ["No private keys or live execution involved.", "Treat this text as commentary only."],
      };
      const parsed = schema.safeParse(draft);
      if (!parsed.success) {
        return { ok: false, code: "INVALID", error: "Mock advisory failed schema validation", provider: this.id };
      }
      return {
        ok: true,
        data: parsed.data,
        provider: this.id,
        model: request.model,
        cached: false,
        latencyMs: Date.now() - started,
      };
    }
    return { ok: false, code: "UNAVAILABLE", error: "Mock provider has no classifier payload", provider: this.id };
  }
}

/** Hosted OpenAI-compatible chat completions. Works offline as UNAVAILABLE without a key. */
export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id: string;

  constructor(
    private readonly options: {
      id?: string;
      apiKey: string | undefined;
      baseUrl?: string;
      fetchImpl?: typeof fetch;
      cache?: Map<string, unknown>;
    },
  ) {
    this.id = options.id ?? "openai-compatible";
  }

  async completeJson<T>(request: LlmRequest, schema: z.ZodType<T>): Promise<LlmResult<T>> {
    const started = Date.now();
    if (!this.options.apiKey) {
      return { ok: false, code: "UNAVAILABLE", error: "LLM API key is not configured", provider: this.id };
    }
    const cacheKey = `${request.model}:${request.purpose}:${hash(request.messages)}`;
    const cache = this.options.cache;
    if (cache?.has(cacheKey)) {
      const cached = schema.safeParse(cache.get(cacheKey));
      if (cached.success) {
        return {
          ok: true,
          data: cached.data,
          provider: this.id,
          model: request.model,
          cached: true,
          latencyMs: Date.now() - started,
        };
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const fetchImpl = this.options.fetchImpl ?? fetch;
      const response = await fetchImpl(`${this.options.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          max_tokens: request.maxTokens,
          response_format: { type: "json_object" },
        }),
      });
      if (!response.ok) {
        return { ok: false, code: "UPSTREAM", error: `LLM HTTP ${response.status}`, provider: this.id };
      }
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (!content) return { ok: false, code: "INVALID", error: "LLM response missing content", provider: this.id };
      let json: unknown;
      try {
        json = JSON.parse(content);
      } catch {
        return { ok: false, code: "INVALID", error: "LLM response was not JSON", provider: this.id };
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        return { ok: false, code: "INVALID", error: "LLM JSON failed schema validation", provider: this.id };
      }
      cache?.set(cacheKey, parsed.data);
      return {
        ok: true,
        data: parsed.data,
        provider: this.id,
        model: request.model,
        cached: false,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        code: aborted ? "TIMEOUT" : "UPSTREAM",
        error: error instanceof Error ? error.message : "LLM request failed",
        provider: this.id,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Optional Hermes-compatible endpoint (OpenAI chat schema). */
export function createHermesProvider(apiKey: string | undefined, baseUrl: string): ModelProvider {
  return new OpenAiCompatibleProvider({ id: "hermes", apiKey, baseUrl });
}

export function createModelProvider(env: {
  OPENAI_API_KEY?: string;
  HERMES_BASE_URL?: string;
  HERMES_API_KEY?: string;
}): ModelProvider {
  if (env.HERMES_BASE_URL) {
    return createHermesProvider(env.HERMES_API_KEY || env.OPENAI_API_KEY, env.HERMES_BASE_URL);
  }
  if (env.OPENAI_API_KEY) {
    return new OpenAiCompatibleProvider({ apiKey: env.OPENAI_API_KEY });
  }
  return new MockModelProvider();
}

/** Advisory hook for ARCHIVIST / AEGIS review text. Never fed into fill/size/risk gates. */
export async function advisoryReview(
  provider: ModelProvider,
  context: { agent: "ARCHIVIST" | "AEGIS"; facts: Record<string, unknown> },
): Promise<{ text: string | null; result: LlmResult<AdvisorySummary> }> {
  const result = await provider.completeJson(
    {
      model: context.agent === "ARCHIVIST" ? "research-strong" : "classify-small",
      purpose: context.agent === "ARCHIVIST" ? "post_trade" : "summarise",
      maxTokens: 400,
      timeoutMs: 8_000,
      messages: [
        {
          role: "system",
          content:
            "You produce advisory-only JSON. Never invent prices, fills, win rates, or returns. Deterministic risk code is authoritative.",
        },
        { role: "user", content: JSON.stringify(context.facts) },
      ],
    },
    advisorySummarySchema,
  );
  if (!result.ok) return { text: null, result };
  return { text: [result.data.summary, ...result.data.bullets].join(" "), result };
}

function hash(messages: LlmMessage[]): string {
  return messages.map((message) => `${message.role}:${message.content}`).join("|").slice(0, 512);
}
