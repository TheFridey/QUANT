/**
 * Static source lint.
 * This layer rejects obvious dangerous syntax before compilation. It is a lint for
 * honest mistakes, not a security control: string concatenation bypasses it trivially.
 * It is not a sandbox and it is not proof of runtime isolation.
 */

export const STATIC_GATE_NAME = "STATIC_SOURCE_GATE" as const;

const FORBIDDEN_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "ENV_ACCESS", pattern: /process\.env/ },
  { code: "ENV_ACCESS", pattern: /process\s*\[\s*["']env["']\s*\]/ },
  { code: "DYNAMIC_IMPORT", pattern: /\bimport\s*\(/ },
  { code: "DYNAMIC_IMPORT", pattern: /\brequire\s*\(/ },
  { code: "MODULE_IMPORT", pattern: /\bimport\s+/ },
  { code: "FILESYSTEM", pattern: /\bfrom\s+["'](?:node:)?fs(?:\/promises)?["']/ },
  { code: "FILESYSTEM", pattern: /\bnode:fs\b/ },
  { code: "CHILD_PROCESS", pattern: /\b(?:node:)?child_process\b/ },
  { code: "NETWORK", pattern: /\b(?:node:)?(?:net|http|https|dns|tls)\b/ },
  { code: "NETWORK", pattern: /\bfetch\s*\(/ },
  { code: "NETWORK", pattern: /\bWebSocket\b/ },
  { code: "WORKER", pattern: /\bworker_threads\b/ },
  { code: "VM", pattern: /\bnode:vm\b|\bfrom\s+["']vm["']/ },
  { code: "EVAL", pattern: /\beval\s*\(/ },
  { code: "EVAL", pattern: /\bFunction\s*\(/ },
  { code: "SECRET_EXTRACTION", pattern: /DATABASE_URL|REDIS_URL|PRIVATE_KEY|API_KEY|SECRET|JWT_SECRET|OPENAI_API_KEY|ANTHROPIC_API_KEY/ },
  { code: "RISK_MUTATION", pattern: /overrideRisk|maxDailyLossPct\s*=|allowRiskLimitMutation/i },
  { code: "ORDER_PLACEMENT", pattern: /placeOrder\s*\(|submitOrder\s*\(|real[_-]?money/i },
  { code: "BROKER", pattern: /\bbroker\b/i },
];

/** Runtime dependency allowlist. Generated strategies receive no third-party modules. */
export const STRATEGY_DEPENDENCY_ALLOWLIST: readonly string[] = [];

export type StaticFinding = { code: string; detail: string };

export function staticCheck(source: string): string[] {
  return inspectSource(source).map((finding) => `${finding.code}: ${finding.detail}`);
}

export function inspectSource(source: string): StaticFinding[] {
  const findings: StaticFinding[] = [];
  if (!source.trim()) {
    findings.push({ code: "EMPTY", detail: "Strategy source is empty" });
    return findings;
  }
  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(source)) {
      findings.push({ code: rule.code, detail: `Forbidden pattern ${rule.pattern}` });
    }
  }
  if (!/export\s+function\s+onBar\b/.test(source) && !/exports\.onBar\s*=/.test(source)) {
    findings.push({ code: "CONTRACT", detail: "Source must export function onBar" });
  }
  return findings;
}
