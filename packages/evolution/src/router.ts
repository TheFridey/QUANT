import { z } from "zod";
import {
  MockModelProvider,
  OpenAiCompatibleProvider,
  UnavailableModelProvider,
  createHermesProvider,
  type LlmRequest,
  type LlmResult,
  type ModelProvider,
} from "@odin/agent-core";
import { d, MODEL_TIERS, type ModelTier } from "@odin/shared";
import { BudgetStoreUnreadableError, COMPLETION_ESTIMATE_BOUND_FACTOR, FileBudgetStore, MemoryBudgetStore, type BudgetStore } from "./budget-store.js";

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
  costKind: "ESTIMATED" | "ACTUAL";
  provenance: "LIVE" | "MOCK" | "FIXTURE" | "UNAVAILABLE";
  error?: string;
};

export type BudgetState = {
  capUsd: string;
  /** Null when the spend record cannot be read; the remaining budget is then zero (fail closed). */
  spentUsd: string | null;
  remainingUsd: string;
  unavailableReason?: string;
};

export type EndpointHealth = {
  id: string;
  tier: ModelTier;
  kind: ProviderKind;
  model: string;
  availability: "CONFIGURED" | "UNAVAILABLE" | "MOCK";
};

export type RouterMode = "live" | "mock";

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
  {
    id: "challenge-primary",
    kind: "openai-compatible",
    tier: "INDEPENDENT_CHALLENGE",
    model: process.env.ODIN_CHALLENGE_MODEL ?? "challenge-reviewer",
    apiKeyEnv: "ODIN_CHALLENGE_API_KEY",
    baseUrl: process.env.ODIN_CHALLENGE_BASE_URL,
    maxTokensDefault: 800,
    costPer1kInputUsd: "0.002",
    costPer1kOutputUsd: "0.008",
  },
];

export const DEFAULT_ASSIGNMENTS: ModelAssignment[] = [
  {
    agentOrTask: "SENTINEL",
    tier: "FAST_OBSERVERS",
    primaryEndpointId: "hermes-primary",
    fallbackEndpointIds: ["openai-primary"],
  },
  {
    agentOrTask: "PULSE",
    tier: "FAST_OBSERVERS",
    primaryEndpointId: "hermes-primary",
    fallbackEndpointIds: [],
  },
  {
    agentOrTask: "ORACLE",
    tier: "DEEP_RESEARCHERS",
    primaryEndpointId: "openai-primary",
    fallbackEndpointIds: [],
  },
  {
    agentOrTask: "FORGE",
    tier: "ENGINEERING_AGENTS",
    primaryEndpointId: "anthropic-primary",
    fallbackEndpointIds: [],
  },
  {
    agentOrTask: "CHALLENGE",
    tier: "INDEPENDENT_CHALLENGE",
    primaryEndpointId: "challenge-primary",
    fallbackEndpointIds: [],
  },
];

/**
 * Live mode is the default. Missing credentials return UNAVAILABLE.
 * Mock output is produced only when mode is explicitly "mock", and it is labelled MOCK.
 * Injected providers (including FIXTURE) are used as given and never relabelled as a frontier model.
 */
export class ModelRouter {
  readonly usage: UsageRecord[] = [];
  private readonly budgetStore: BudgetStore;
  private readonly mode: RouterMode;

  constructor(
    private readonly options: {
      endpoints?: ModelEndpoint[];
      assignments?: ModelAssignment[];
      budgetCapUsd?: number | string;
      env?: NodeJS.ProcessEnv;
      providers?: Map<string, ModelProvider>;
      mode?: RouterMode;
      budgetStore?: BudgetStore;
      budgetPath?: string;
      /**
       * Called (and awaited) after every model call, before the next one, so spend is recorded durably as
       * it happens rather than at the end of a run. If it throws, the call fails and no further call is made.
       */
      onUsage?: (usage: UsageRecord) => Promise<void>;
    } = {},
  ) {
    this.mode = options.mode ?? "live";
    this.budgetStore =
      options.budgetStore ??
      (options.budgetPath ? new FileBudgetStore(options.budgetPath) : new MemoryBudgetStore());
  }

  get endpoints(): ModelEndpoint[] {
    return this.options.endpoints ?? DEFAULT_ENDPOINTS;
  }

  get assignments(): ModelAssignment[] {
    return this.options.assignments ?? DEFAULT_ASSIGNMENTS;
  }

  budget(): BudgetState {
    const cap = d(String(this.options.budgetCapUsd ?? "5"));
    let spentUsd: string;
    try {
      spentUsd = this.budgetStore.read().spentUsd;
    } catch (error) {
      if (!(error instanceof BudgetStoreUnreadableError)) throw error;
      return { capUsd: cap.toFixed(4), spentUsd: null, remainingUsd: "0.00000000", unavailableReason: error.message };
    }
    const spent = d(spentUsd);
    const remaining = spent.gte(cap) ? d("0") : cap.minus(spent);
    return {
      capUsd: cap.toFixed(4),
      spentUsd: spent.toFixed(8),
      remainingUsd: remaining.toFixed(8),
    };
  }

  assignmentFor(agentOrTask: string): ModelAssignment {
    return (
      this.assignments.find((row) => row.agentOrTask === agentOrTask) ?? {
        agentOrTask,
        tier: "FAST_OBSERVERS",
        primaryEndpointId: "hermes-primary",
        fallbackEndpointIds: [],
      }
    );
  }

  /** FORGE and CHALLENGE must not share a primary endpoint. */
  assertSeparatedReviewer(): { separated: boolean; forgeEndpointId: string; challengeEndpointId: string } {
    const forgeEndpointId = this.assignmentFor("FORGE").primaryEndpointId;
    const challengeEndpointId = this.assignmentFor("CHALLENGE").primaryEndpointId;
    return {
      separated: forgeEndpointId !== challengeEndpointId,
      forgeEndpointId,
      challengeEndpointId,
    };
  }

  /** Availability only. API keys are never copied into this view. */
  health(): EndpointHealth[] {
    const env = this.options.env ?? process.env;
    return this.endpoints.map((endpoint) => {
      const injected = this.options.providers?.get(endpoint.id);
      if (injected) {
        return {
          id: endpoint.id,
          tier: endpoint.tier,
          kind: endpoint.kind,
          model: injected.id === "fixture" ? "FIXTURE" : endpoint.model,
          availability: injected.id === "mock" ? "MOCK" : "CONFIGURED",
        };
      }
      if (endpoint.kind === "mock") {
        return {
          id: endpoint.id,
          tier: endpoint.tier,
          kind: endpoint.kind,
          model: endpoint.model,
          availability: this.mode === "mock" ? "MOCK" : "UNAVAILABLE",
        };
      }
      const keyName = endpoint.apiKeyEnv;
      const keyPresent = Boolean(keyName && env[keyName]);
      const needsBase = endpoint.kind === "hermes-compatible";
      const basePresent = Boolean(endpoint.baseUrl || env.HERMES_BASE_URL);
      const configured = needsBase ? basePresent : keyPresent;
      return {
        id: endpoint.id,
        tier: endpoint.tier,
        kind: endpoint.kind,
        model: endpoint.model,
        availability: configured ? "CONFIGURED" : "UNAVAILABLE",
      };
    });
  }

  async completeJson<T>(
    agentOrTask: string,
    request: Omit<LlmRequest, "model"> & { model?: string },
    schema: z.ZodType<T>,
  ): Promise<LlmResult<T> & { usage?: UsageRecord }> {
    const assignment = this.assignmentFor(agentOrTask);
    const chain = [assignment.primaryEndpointId, ...assignment.fallbackEndpointIds];
    if (d(this.budget().remainingUsd).lte(0)) {
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
      if (d(this.budget().remainingUsd).lte(0)) break;
      const endpoint = this.endpoints.find((row) => row.id === endpointId);
      if (!endpoint) continue;
      const provider = this.resolveProvider(endpoint);
      const model = request.model ?? endpoint.model;
      let attempt = 0;
      let result: LlmResult<T>;
      do {
        const started = Date.now();
        result = await this.callWithTimeout(
          provider,
          {
            ...request,
            model,
            maxTokens: request.maxTokens || endpoint.maxTokensDefault,
          },
          schema,
        );
        const promptTokensEst = estimateTokens(request.messages.map((message) => message.content).join(" "));
        // Capped at the bound a reservation covers (2 × the token limit): a provider cannot return more tokens
        // than the limit, so a longer character-based estimate never exceeds what was reserved for the call.
        const completionTokensEst = result.ok
          ? Math.min(estimateTokens(JSON.stringify(result.data)), COMPLETION_ESTIMATE_BOUND_FACTOR * (request.maxTokens || endpoint.maxTokensDefault))
          : 0;
        const costUsdEst = estimateCost(endpoint, promptTokensEst, completionTokensEst);
        this.budgetStore.add(costUsdEst);
        const usage: UsageRecord = {
          at: new Date().toISOString(),
          agentOrTask,
          endpointId: endpoint.id,
          provider: provider.id,
          model: provider.id === "fixture" ? "FIXTURE" : model,
          tier: endpoint.tier,
          ok: result.ok,
          latencyMs: result.ok ? result.latencyMs : Date.now() - started,
          promptTokensEst,
          completionTokensEst,
          costUsdEst,
          costKind: "ESTIMATED",
          provenance: provenanceFor(endpoint, provider, this.mode, result),
          error: result.ok ? undefined : result.error,
        };
        this.usage.push(usage);
        if (this.options.onUsage) await this.options.onUsage(usage);
        if (result.ok) return { ...result, usage };
        attempt += 1;
      } while (attempt < 2 && !result.ok && (result.code === "TIMEOUT" || result.code === "UPSTREAM"));
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
    provenance: UsageRecord["provenance"];
    costKind: UsageRecord["costKind"];
  }> {
    return this.usage.map((row) => ({
      agentOrTask: row.agentOrTask,
      endpointId: row.endpointId,
      ok: row.ok,
      latencyMs: row.latencyMs,
      costUsdEst: row.costUsdEst,
      provenance: row.provenance,
      costKind: row.costKind,
    }));
  }

  private async callWithTimeout<T>(
    provider: ModelProvider,
    request: LlmRequest,
    schema: z.ZodType<T>,
  ): Promise<LlmResult<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<LlmResult<T>>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          ok: false,
          code: "TIMEOUT",
          error: "Router timeout",
          provider: provider.id,
        });
      }, request.timeoutMs);
    });
    try {
      return await Promise.race([provider.completeJson(request, schema), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private resolveProvider(endpoint: ModelEndpoint): ModelProvider {
    const injected = this.options.providers?.get(endpoint.id);
    if (injected) return injected;
    if (this.mode === "mock") return new MockModelProvider();
    if (endpoint.kind === "mock") return new UnavailableModelProvider();
    const env = this.options.env ?? process.env;
    if (endpoint.kind === "hermes-compatible") {
      return createHermesProvider(
        env[endpoint.apiKeyEnv ?? "HERMES_API_KEY"],
        endpoint.baseUrl ?? env.HERMES_BASE_URL ?? "",
      );
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

function estimateCost(endpoint: ModelEndpoint, promptTokens: number, completionTokens: number): string {
  const input = d(String(promptTokens)).div(1000).mul(d(endpoint.costPer1kInputUsd));
  const output = d(String(completionTokens)).div(1000).mul(d(endpoint.costPer1kOutputUsd));
  return input.plus(output).toFixed(8);
}

function provenanceFor(
  endpoint: ModelEndpoint,
  provider: ModelProvider,
  mode: RouterMode,
  result: { ok: boolean },
): UsageRecord["provenance"] {
  if (provider.id === "fixture") return result.ok ? "FIXTURE" : "UNAVAILABLE";
  if (mode === "mock" || endpoint.kind === "mock" || provider.id === "mock") {
    return result.ok ? "MOCK" : "UNAVAILABLE";
  }
  if (!result.ok) return "UNAVAILABLE";
  return "LIVE";
}
