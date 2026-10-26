import { z } from "zod";
import {
  MockModelProvider,
  OpenAiCompatibleProvider,
  createHermesProvider,
  type LlmRequest,
  type LlmResult,
  type ModelProvider,
} from "@odin/agent-core";
import { MODEL_TIERS, type ModelTier } from "@odin/shared";

export type ProviderKind = "openai-compatible" | "anthropic-compatible" | "hermes-compatible" | "mock";

export type ModelEndpoint = {
  id: string;
  kind: ProviderKind;
  tier: ModelTier;
  /** Logical model name — never hardcode vendor version strings in callers. */
  model: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  maxTokensDefault: number;
  costPer1kInputUsd: string;
  costPer1kOutputUsd: string;
};

export type ModelAssignment = {
  agentOrTask: string;
  tier: ModelTier;
  primaryEndpointId: string;
  fallbackEndpointIds: string[];
};

export type UsageRecord = {
  at: string;
  agentOrTask: string;
  endpointId: string;
  provider: string;
  model: string;
  tier: ModelTier;
  ok: boolean;
  latencyMs: number;
  promptTokensEst: number;
  completionTokensEst: number;
  costUsdEst: string;
  error?: string;
};

export type BudgetState = {
  capUsd: string;
  spentUsd: string;
  remainingUsd: string;
};

const anthropicMessageSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
});

/** Anthropic-compatible adapter using Messages API shape when a key is present. */
export class AnthropicCompatibleProvider implements ModelProvider {
  readonly id: string;

  constructor(
    private readonly options: {
      id?: string;
      apiKey: string | undefined;
      baseUrl?: string;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.id = options.id ?? "anthropic-compatible";
  }

  async completeJson<T>(request: LlmRequest, schema: z.ZodType<T>): Promise<LlmResult<T>> {
    const started = Date.now();
    if (!this.options.apiKey) {
      return { ok: false, code: "UNAVAILABLE", error: "Anthropic API key is not configured", provider: this.id };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const fetchImpl = this.options.fetchImpl ?? fetch;
      const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
      const messages = request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
      const response = await fetchImpl(`${this.options.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.maxTokens,
          system: system || undefined,
          messages,
        }),
      });
      if (!response.ok) {
        return { ok: false, code: "UPSTREAM", error: `Anthropic HTTP ${response.status}`, provider: this.id };
      }
      const body = anthropicMessageSchema.parse(await response.json());
      const text = body.content?.find((part) => part.type === "text")?.text;
      if (!text) return { ok: false, code: "INVALID", error: "Anthropic response missing text", provider: this.id };
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, code: "INVALID", error: "Anthropic response was not JSON", provider: this.id };
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        return { ok: false, code: "INVALID", error: "Anthropic JSON failed schema validation", provider: this.id };
      }
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
        error: error instanceof Error ? error.message : "Anthropic request failed",
        provider: this.id,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const DEFAULT_ENDPOINTS: ModelEndpoint[] = [
  {
    id: "fast-mock",
    kind: "mock",
    tier: "FAST_OBSERVERS",
    model: "observer-fast",
    maxTokensDefault: 400,
    costPer1kInputUsd: "0",
    costPer1kOutputUsd: "0",
  },
  {
    id: "deep-mock",
    kind: "mock",
    tier: "DEEP_RESEARCHERS",
    model: "researcher-deep",
    maxTokensDefault: 800,
    costPer1kInputUsd: "0",
    costPer1kOutputUsd: "0",
  },
  {
    id: "eng-mock",
    kind: "mock",
    tier: "ENGINEERING_AGENTS",
    model: "engineer-codegen",
    maxTokensDefault: 1200,
    costPer1kInputUsd: "0",
    costPer1kOutputUsd: "0",
  },
  {
    id: "openai-primary",
    kind: "openai-compatible",
    tier: "DEEP_RESEARCHERS",
    model: process.env.ODIN_OPENAI_MODEL ?? "gpt-research",
    apiKeyEnv: "OPENAI_API_KEY",
    maxTokensDefault: 800,
    costPer1kInputUsd: "0.002",
    costPer1kOutputUsd: "0.008",
  },
  {
    id: "anthropic-primary",
    kind: "anthropic-compatible",
    tier: "ENGINEERING_AGENTS",
    model: process.env.ODIN_ANTHROPIC_MODEL ?? "claude-research",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    maxTokensDefault: 1200,
    costPer1kInputUsd: "0.003",
    costPer1kOutputUsd: "0.015",
  },
  {
    id: "hermes-primary",
    kind: "hermes-compatible",
    tier: "FAST_OBSERVERS",
    model: process.env.ODIN_HERMES_MODEL ?? "hermes-observer",
    apiKeyEnv: "HERMES_API_KEY",
    baseUrl: process.env.HERMES_BASE_URL,
    maxTokensDefault: 400,
    costPer1kInputUsd: "0.001",
    costPer1kOutputUsd: "0.002",
  },
];

export const DEFAULT_ASSIGNMENTS: ModelAssignment[] = [
  {
    agentOrTask: "SENTINEL",
    tier: "FAST_OBSERVERS",
    primaryEndpointId: "hermes-primary",
    fallbackEndpointIds: ["fast-mock"],
  },
  {
    agentOrTask: "PULSE",
    tier: "FAST_OBSERVERS",
    primaryEndpointId: "fast-mock",
    fallbackEndpointIds: [],
  },
  {
    agentOrTask: "ORACLE",
    tier: "DEEP_RESEARCHERS",
    primaryEndpointId: "openai-primary",
    fallbackEndpointIds: ["deep-mock"],
  },
  {
    agentOrTask: "FORGE",
    tier: "ENGINEERING_AGENTS",
    primaryEndpointId: "anthropic-primary",
    fallbackEndpointIds: ["eng-mock"],
  },
  {
    agentOrTask: "CHALLENGE",
    tier: "DEEP_RESEARCHERS",
    primaryEndpointId: "openai-primary",
    fallbackEndpointIds: ["deep-mock"],
  },
];

export class ModelRouter {
  private spentUsd = 0;
  readonly usage: UsageRecord[] = [];

  constructor(
    private readonly options: {
      endpoints?: ModelEndpoint[];
      assignments?: ModelAssignment[];
      budgetCapUsd?: number;
      env?: NodeJS.ProcessEnv;
      providers?: Map<string, ModelProvider>;
    } = {},
  ) {}

  get endpoints(): ModelEndpoint[] {
    return this.options.endpoints ?? DEFAULT_ENDPOINTS;
  }

  get assignments(): ModelAssignment[] {
    return this.options.assignments ?? DEFAULT_ASSIGNMENTS;
  }

  budget(): BudgetState {
    const cap = this.options.budgetCapUsd ?? 5;
    const remaining = Math.max(0, cap - this.spentUsd);
    return {
      capUsd: cap.toFixed(4),
      spentUsd: this.spentUsd.toFixed(4),
      remainingUsd: remaining.toFixed(4),
    };
  }

  assignmentFor(agentOrTask: string): ModelAssignment {
    return (
      this.assignments.find((row) => row.agentOrTask === agentOrTask) ?? {
        agentOrTask,
        tier: "FAST_OBSERVERS",
        primaryEndpointId: "fast-mock",
        fallbackEndpointIds: [],
      }
    );
  }

  async completeJson<T>(
    agentOrTask: string,
    request: Omit<LlmRequest, "model"> & { model?: string },
    schema: z.ZodType<T>,
  ): Promise<LlmResult<T> & { usage?: UsageRecord }> {
    const assignment = this.assignmentFor(agentOrTask);
    const chain = [assignment.primaryEndpointId, ...assignment.fallbackEndpointIds];
    const budget = this.budget();
    if (Number(budget.remainingUsd) <= 0) {
      return {
        ok: false,
        code: "UNAVAILABLE",
        error: "Model budget cap reached",
        provider: "router",
      };
    }

    let last: LlmResult<T> = {
      ok: false,
      code: "UNAVAILABLE",
      error: "No endpoints",
      provider: "router",
    };

    for (const endpointId of chain) {
      const endpoint = this.endpoints.find((row) => row.id === endpointId);
      if (!endpoint) continue;
      const provider = this.resolveProvider(endpoint);
      const started = Date.now();
      const result = await provider.completeJson(
        {
          ...request,
          model: request.model ?? endpoint.model,
          maxTokens: request.maxTokens || endpoint.maxTokensDefault,
        },
        schema,
      );
      const promptTokensEst = estimateTokens(request.messages.map((m) => m.content).join(" "));
      const completionTokensEst = result.ok ? estimateTokens(JSON.stringify(result.data)) : 0;
      const cost =
        (promptTokensEst / 1000) * Number(endpoint.costPer1kInputUsd) +
        (completionTokensEst / 1000) * Number(endpoint.costPer1kOutputUsd);
      this.spentUsd += cost;
      const usage: UsageRecord = {
        at: new Date().toISOString(),
        agentOrTask,
        endpointId: endpoint.id,
        provider: provider.id,
        model: request.model ?? endpoint.model,
        tier: endpoint.tier,
        ok: result.ok,
        latencyMs: result.ok ? result.latencyMs : Date.now() - started,
        promptTokensEst,
        completionTokensEst,
        costUsdEst: cost.toFixed(6),
        error: result.ok ? undefined : result.error,
      };
      this.usage.push(usage);
      if (result.ok) return { ...result, usage };
      last = result;
    }
    return last;
  }

  comparisonLog(): Array<{
    agentOrTask: string;
    endpointId: string;
    ok: boolean;
    latencyMs: number;
    costUsdEst: string;
  }> {
    return this.usage.map((row) => ({
      agentOrTask: row.agentOrTask,
      endpointId: row.endpointId,
      ok: row.ok,
      latencyMs: row.latencyMs,
      costUsdEst: row.costUsdEst,
    }));
  }

  private resolveProvider(endpoint: ModelEndpoint): ModelProvider {
    const cached = this.options.providers?.get(endpoint.id);
    if (cached) return cached;
    const env = this.options.env ?? process.env;
    if (endpoint.kind === "mock") return new MockModelProvider();
    if (endpoint.kind === "hermes-compatible") {
      return createHermesProvider(env[endpoint.apiKeyEnv ?? "HERMES_API_KEY"], endpoint.baseUrl ?? env.HERMES_BASE_URL ?? "");
    }
    if (endpoint.kind === "anthropic-compatible") {
      return new AnthropicCompatibleProvider({
        id: endpoint.id,
        apiKey: env[endpoint.apiKeyEnv ?? "ANTHROPIC_API_KEY"],
        baseUrl: endpoint.baseUrl,
      });
    }
    return new OpenAiCompatibleProvider({
      id: endpoint.id,
      apiKey: env[endpoint.apiKeyEnv ?? "OPENAI_API_KEY"],
      baseUrl: endpoint.baseUrl,
    });
  }
}

export function assertKnownTier(): readonly ModelTier[] {
  return MODEL_TIERS;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
