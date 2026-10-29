import type { z } from "zod";
import type { ExternalErrorCode, ExternalResult, ExternalRetryClass } from "./execution-contract.js";
import { assertAllowlistedHttpsUrl, type AllowedHost } from "./practice-url.js";

/**
 * Credential-bearing HTTP transport for external venues.
 *
 * - Never follows redirects (credentials must not leave the allowlisted host).
 * - Never auto-retries economic mutations or cancels; idempotent reads retry a bounded number of times.
 * - Responses are validated at runtime; error strings are sanitized and truncated.
 */

export type HttpOperation = "read" | "economic_mutation" | "cancel";

export type HttpMethod = "GET" | "POST" | "DELETE" | "PATCH";

export type HttpTransportConfig = {
  baseUrl: string;
  allowlist: readonly AllowedHost[];
  /** Sent on every request; values are redacted from any error text. */
  credentialHeaders: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Total attempts for idempotent reads (>=1). Mutations and cancels are always single-attempt. */
  maxReadAttempts?: number;
  /** Longest Retry-After the transport will sleep for before giving up and returning RATE_LIMITED. */
  maxRetryAfterMs?: number;
  /** Base for exponential backoff between read retries when no Retry-After is given. */
  backoffBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type HttpRequest = {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  operation: HttpOperation;
};

const MAX_ERROR_BODY_CHARS = 200;
const DEFAULT_TIMEOUT_MS = 15_000;

type Failure = Extract<ExternalResult<never>, { ok: false }>;

export function classifyRetry(code: ExternalErrorCode, operation: HttpOperation): ExternalRetryClass {
  switch (code) {
    case "RATE_LIMITED":
      return "backoff";
    case "NOT_FOUND":
      return operation === "read" ? "idempotent_retry" : "none";
    case "SERVER_ERROR":
      if (operation === "economic_mutation") return "reconcile_before_resubmit";
      return operation === "cancel" ? "idempotent_retry" : "backoff";
    case "TIMEOUT":
    case "NETWORK":
    case "UNKNOWN_OUTCOME":
      return operation === "economic_mutation" ? "reconcile_before_resubmit" : "idempotent_retry";
    case "MALFORMED_RESPONSE":
    case "REDIRECT_REFUSED":
      if (operation === "economic_mutation") return "reconcile_before_resubmit";
      return operation === "cancel" ? "idempotent_retry" : "none";
    default:
      return "none";
  }
}

/** Parses Retry-After as delta-seconds or an HTTP-date; returns milliseconds (>=0) or undefined. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - nowMs);
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

function sanitizeBody(text: string, secrets: readonly string[]): string {
  let message = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string") {
      message = parsed.message;
    }
  } catch {
    // non-JSON error body — keep raw text
  }
  const clean = redactSecrets(message, secrets).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean.length > MAX_ERROR_BODY_CHARS ? `${clean.slice(0, MAX_ERROR_BODY_CHARS)}…` : clean;
}

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return base === "application/json" || base.endsWith("+json");
}

export class HttpTransport {
  private readonly secrets: string[];
  private readonly origin: string | null;
  private readonly hostError: string | null;

  constructor(private readonly config: HttpTransportConfig) {
    this.secrets = Object.values(config.credentialHeaders).filter((v) => v.length > 0);
    const checked = assertAllowlistedHttpsUrl(config.baseUrl, config.allowlist);
    if (checked.ok) {
      this.origin = checked.url.origin;
      this.hostError = null;
    } else {
      this.origin = null;
      this.hostError = checked.reason;
    }
  }

  hostCheck(): { ok: true; origin: string } | { ok: false; reason: string } {
    if (this.origin) return { ok: true, origin: this.origin };
    return { ok: false, reason: this.hostError ?? "HOST_REJECTED" };
  }

  /** JSON response validated against `schema`. Empty or non-JSON bodies are MALFORMED_RESPONSE. */
  async requestJson<S extends z.ZodType>(req: HttpRequest, schema: S): Promise<ExternalResult<z.output<S>>> {
    const res = await this.execute(req);
    if (!res.ok) return res;
    const { text, contentType, status } = res.value;
    const label = this.label(req);
    if (text.trim() === "") {
      return this.fail("MALFORMED_RESPONSE", req.operation, `${label}: HTTP ${status} empty body where JSON expected`, status);
    }
    if (!isJsonContentType(contentType)) {
      return this.fail(
        "MALFORMED_RESPONSE",
        req.operation,
        `${label}: HTTP ${status} unexpected content-type ${sanitizeBody(contentType ?? "none", this.secrets)}`,
        status,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return this.fail("MALFORMED_RESPONSE", req.operation, `${label}: HTTP ${status} invalid JSON`, status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
        .join("; ");
      return this.fail("MALFORMED_RESPONSE", req.operation, `${label}: schema mismatch (${issues})`, status);
    }
    return { ok: true, value: parsed.data };
  }

  /** Any 2xx is success; the body (including an empty 204) is ignored. */
  async requestNoContent(req: HttpRequest): Promise<ExternalResult<{ status: number }>> {
    const res = await this.execute(req);
    if (!res.ok) return res;
    return { ok: true, value: { status: res.value.status } };
  }

  private label(req: HttpRequest): string {
    return `${req.method} ${req.path}`;
  }

  private fail(
    code: ExternalErrorCode,
    operation: HttpOperation,
    error: string,
    httpStatus?: number,
    retryAfterMs?: number,
  ): Failure {
    return {
      ok: false,
      code,
      error: redactSecrets(error, this.secrets),
      retryClass: classifyRetry(code, operation),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }

  private buildUrl(req: HttpRequest): ExternalResult<URL> {
    if (!this.origin) {
      return this.fail("INVALID_CONFIGURATION", req.operation, `host rejected: ${this.hostError ?? "unknown"}`);
    }
    if (!req.path.startsWith("/") || req.path.startsWith("//") || req.path.includes("://")) {
      return this.fail("INVALID_CONFIGURATION", req.operation, "request path must be origin-relative");
    }
    const url = new URL(req.path, this.origin);
    if (url.origin !== this.origin) {
      return this.fail("INVALID_CONFIGURATION", req.operation, "request path escaped the allowlisted origin");
    }
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    return { ok: true, value: url };
  }

  private async execute(
    req: HttpRequest,
  ): Promise<ExternalResult<{ status: number; text: string; contentType: string | null }>> {
    const built = this.buildUrl(req);
    if (!built.ok) return built;
    const maxAttempts = req.operation === "read" ? Math.max(1, this.config.maxReadAttempts ?? 3) : 1;
    const sleep = this.config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const maxRetryAfterMs = this.config.maxRetryAfterMs ?? 30_000;
    const backoffBase = this.config.backoffBaseMs ?? 250;
    let last: Failure | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const res = await this.once(req, built.value);
      if (res.ok) return res;
      last = res;
      const retryable =
        res.code === "RATE_LIMITED" || res.code === "SERVER_ERROR" || res.code === "TIMEOUT" || res.code === "NETWORK";
      if (!retryable || attempt === maxAttempts) break;
      const wait = res.retryAfterMs ?? backoffBase * 2 ** (attempt - 1);
      if (wait > maxRetryAfterMs) break;
      await sleep(wait);
    }
    return last ?? this.fail("UNKNOWN_OUTCOME", req.operation, `${this.label(req)}: no attempt made`);
  }

  private async once(
    req: HttpRequest,
    url: URL,
  ): Promise<ExternalResult<{ status: number; text: string; contentType: string | null }>> {
    const label = this.label(req);
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const headers: Record<string, string> = { Accept: "application/json", ...this.config.credentialHeaders };
    if (req.body !== undefined) headers["Content-Type"] = "application/json";
    try {
      const res = await fetchImpl(url, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: controller.signal,
        redirect: "manual",
      });
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        await res.body?.cancel().catch(() => undefined);
        return this.fail("REDIRECT_REFUSED", req.operation, `${label}: HTTP ${res.status} redirect refused`, res.status || undefined);
      }
      const text = await res.text();
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, value: { status: res.status, text, contentType: res.headers.get("content-type") } };
      }
      const detail = `${label}: HTTP ${res.status} ${sanitizeBody(text, this.secrets)}`.trim();
      if (res.status === 401 || res.status === 403) return this.fail("AUTH_FAILED", req.operation, detail, res.status);
      if (res.status === 404) return this.fail("NOT_FOUND", req.operation, detail, res.status);
      if (res.status === 429) {
        const nowMs = (this.config.now ?? Date.now)();
        return this.fail(
          "RATE_LIMITED",
          req.operation,
          detail,
          res.status,
          parseRetryAfter(res.headers.get("retry-after"), nowMs),
        );
      }
      if (res.status >= 500) return this.fail("SERVER_ERROR", req.operation, detail, res.status);
      return this.fail("VALIDATION_REJECTED", req.operation, detail, res.status);
    } catch (err) {
      if (timedOut) return this.fail("TIMEOUT", req.operation, `${label}: timed out`);
      const name = err instanceof Error ? err.name : "Error";
      const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.name})` : "";
      return this.fail("NETWORK", req.operation, `${label}: network error ${name}${cause}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
