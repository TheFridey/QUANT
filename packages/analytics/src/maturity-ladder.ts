/**
 * HORIZON Phase II maturity ladder. **Pure, read-only, not yet shown in the API or UI.**
 *
 * The existing readiness ladder (`opportunity-scanner.ts`) says whether a quote is usable right now. This
 * ladder says how far an instrument has progressed towards paper eligibility, and names the first blocker:
 *
 *   REGISTERED → CONFIGURED → OBSERVABLE → DATA_VALID → RESEARCH_READY → SHADOW_READY → PAPER_ELIGIBLE
 *
 * Each rung requires every rung below it. An available provider quote reaches OBSERVABLE at most; it is
 * never an approved opportunity. PAPER_ELIGIBLE additionally needs validated research evidence, operator
 * approval, the protected admission path (PCR-2) and the per-instrument flag. Nothing here enables trading.
 */

export const MATURITY_STAGES = [
  "REGISTERED",
  "CONFIGURED",
  "OBSERVABLE",
  "DATA_VALID",
  "RESEARCH_READY",
  "SHADOW_READY",
  "PAPER_ELIGIBLE",
] as const;
export type MaturityStage = (typeof MATURITY_STAGES)[number];

export type MaturityFacts = {
  instrumentId: string;
  /** Registry says this instrument has a paper or research path at all. */
  supported: boolean;
  /** A provider routes it and its credentials are present (by name). */
  providerConfigured: boolean;
  /** A real provider quote was received recently (any quality). */
  quoteObserved: boolean;
  /** The quote passed `assessQuoteAdmission` apart from the instrument flag (two-sided, real-time, fresh, session open). */
  quoteQualified: boolean;
  /** A pinned historical dataset of adequate span and interval exists for the planned campaign. */
  historicalDatasetReady: boolean;
  /** A campaign result for this instrument is a validated candidate under the current DSR protocol. */
  researchValidated: boolean;
  /** A model or strategy is registered for prospective (shadow) evaluation and resolving outcomes. */
  shadowActive: boolean;
  /** Prospective evidence met its pre-registered bar. */
  shadowPassed: boolean;
  /** Operator approved paper entries for this instrument, and the per-instrument flag is on. */
  operatorApproved: boolean;
  /** The protected PCR-2 admission/settlement path is merged and active. */
  protectedAdmissionActive: boolean;
};

export type MaturityResult = { instrumentId: string; stage: MaturityStage; blocker: { code: string; detail: string } | null };

export function classifyMaturity(f: MaturityFacts): MaturityResult {
  const steps: Array<{ ok: boolean; stage: MaturityStage; code: string; detail: string }> = [
    { ok: f.supported, stage: "REGISTERED", code: "NOT_SUPPORTED", detail: "no paper or research path in the registry" },
    { ok: f.providerConfigured, stage: "CONFIGURED", code: "PROVIDER_NOT_CONFIGURED", detail: "no configured provider routes this instrument" },
    { ok: f.quoteObserved, stage: "OBSERVABLE", code: "NO_RECENT_QUOTE", detail: "no recent provider quote" },
    { ok: f.quoteQualified, stage: "DATA_VALID", code: "QUOTE_NOT_QUALIFIED", detail: "quote is stale, one-sided, reference-only or outside the session" },
    {
      ok: f.historicalDatasetReady && f.researchValidated,
      stage: "RESEARCH_READY",
      code: f.historicalDatasetReady ? "NO_VALIDATED_RESEARCH" : "NO_HISTORICAL_DATASET",
      detail: f.historicalDatasetReady ? "no validated campaign candidate (no-skill is a valid result)" : "no pinned dataset adequate for the campaign",
    },
    {
      ok: f.shadowActive && f.shadowPassed,
      stage: "SHADOW_READY",
      code: f.shadowActive ? "SHADOW_EVIDENCE_INSUFFICIENT" : "NO_SHADOW_EVALUATION",
      detail: f.shadowActive ? "prospective evidence has not met its bar" : "not registered for shadow evaluation",
    },
    {
      ok: f.protectedAdmissionActive && f.operatorApproved,
      stage: "PAPER_ELIGIBLE",
      code: f.protectedAdmissionActive ? "NOT_OPERATOR_APPROVED" : "PROTECTED_ADMISSION_NOT_ACTIVE",
      detail: f.protectedAdmissionActive ? "operator has not enabled paper entries" : "PCR-2 admission/settlement path not merged and active",
    },
  ];
  let reached: MaturityStage | null = null;
  for (const step of steps) {
    if (!step.ok) {
      // Below REGISTERED nothing is reached; report REGISTERED with the blocker so the row still renders.
      return { instrumentId: f.instrumentId, stage: reached ?? "REGISTERED", blocker: { code: step.code, detail: step.detail } };
    }
    reached = step.stage;
  }
  return { instrumentId: f.instrumentId, stage: "PAPER_ELIGIBLE", blocker: null };
}

/**
 * Split scanner capacity fairly across asset classes, so a class with many candidates (Solana pools)
 * cannot take every slot. Round-robin over classes in a stable order; within a class, input order is kept
 * (callers sort by their own evidence first). Unused share flows to classes that still have candidates.
 */
export function allocateScanCapacity<T extends { assetClass: string }>(candidates: readonly T[], capacity: number): T[] {
  if (!Number.isInteger(capacity) || capacity <= 0) return [];
  const byClass = new Map<string, T[]>();
  for (const c of candidates) {
    const list = byClass.get(c.assetClass) ?? [];
    list.push(c);
    byClass.set(c.assetClass, list);
  }
  const classes = [...byClass.keys()].sort();
  const out: T[] = [];
  let progressed = true;
  for (let round = 0; out.length < capacity && progressed; round += 1) {
    progressed = false;
    for (const cls of classes) {
      const item = byClass.get(cls)?.[round];
      if (item === undefined) continue;
      progressed = true;
      out.push(item);
      if (out.length >= capacity) break;
    }
  }
  return out;
}
