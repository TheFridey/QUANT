import {
  confidenceFixed,
  d,
  type CyclePair,
  type ReasonCode,
  type SecurityAssessment,
  type SecurityCategory,
  Decimal,
} from "@odin/shared";
import { MODEL_VERSIONS } from "./versions.js";
import type { DecisionDraft } from "./types.js";

export type SecurityProviderPayload = {
  ok: true;
  fetchedAt: string;
  fields: Record<string, string | number | boolean | null>;
} | {
  ok: false;
  code: "UNAVAILABLE" | "UPSTREAM" | "INVALID";
  error: string;
};

export type HolderProviderPayload = {
  ok: true;
  fields: Record<string, string | number | boolean | null>;
  holderCount: string | null;
} | {
  ok: false;
  code: "UNAVAILABLE" | "UPSTREAM" | "INVALID";
  error: string;
};

export type AegisVerdict = {
  assessment: SecurityAssessment;
  decision: DecisionDraft;
  /** Hard-stop simulated entry when true (BLOCK or REVIEW). UNKNOWN from unavailable provider does not hard-stop. */
  blocksEntry: boolean;
};

/** Build a security assessment from optional Birdeye payloads. Missing key → UNKNOWN, not PASS. */
export function assessSecurity(input: {
  tokenAddress: string;
  security: SecurityProviderPayload | null;
  holders: HolderProviderPayload | null;
  liquidityUsd: string | null;
  now?: Date;
  maxAgeMs?: number;
  cached?: SecurityAssessment | null;
}): SecurityAssessment {
  const now = input.now ?? new Date();
  if (input.cached && !isStale(input.cached, now, input.maxAgeMs ?? 3_600_000)) {
    return { ...input.cached, stale: false };
  }

  if (!input.security || !input.security.ok) {
    return unknownAssessment(input.tokenAddress, "unavailable", now, ["SECURITY_UNKNOWN", "UPSTREAM_UNAVAILABLE"]);
  }

  const fields = input.security.fields;
  const mintAuthority = authorityState(fields, ["mintAuthority", "isMintable", "ownerAddress"]);
  const freezeAuthority = authorityState(fields, ["freezeAuthority", "isFreezable"]);
  const transferRestricted = boolField(fields, ["transferFeeEnable", "transfer_hook", "isHoneypot", "nonTransferable"]);
  const token2022 = stringList(fields, ["extensions", "token2022Extensions"]);
  const fraudIndicators: string[] = [];
  if (boolField(fields, ["isHoneypot"]) === true) fraudIndicators.push("honeypot");
  if (boolField(fields, ["isRug"]) === true) fraudIndicators.push("rug_flag");

  let holderConcentration: string | null = null;
  if (input.holders?.ok) {
    holderConcentration = concentrationFromHolders(input.holders);
  }

  const suspiciousDeployer = boolField(fields, ["suspiciousDeployer", "creator_balance_rate"]);
  const liquidityFragile =
    input.liquidityUsd !== null && d(input.liquidityUsd).gt(0) ? d(input.liquidityUsd).lt("10000") : null;
  const largeWalletMove = boolField(fields, ["largeWalletMove", "top10HolderPercent"]);

  const reasonCodes: ReasonCode[] = [];
  let category: SecurityCategory = "PASS";

  if (mintAuthority === "present") {
    reasonCodes.push("MINT_AUTHORITY_PRESENT");
    category = elevate(category, "REVIEW");
  }
  if (freezeAuthority === "present") {
    reasonCodes.push("FREEZE_AUTHORITY_PRESENT");
    category = elevate(category, "REVIEW");
  }
  if (transferRestricted === true) {
    reasonCodes.push("SECURITY_BLOCK");
    category = elevate(category, "BLOCK");
  }
  if (fraudIndicators.length > 0) {
    reasonCodes.push("SECURITY_BLOCK");
    category = elevate(category, "BLOCK");
  }
  if (holderConcentration !== null && d(holderConcentration).gte("50")) {
    reasonCodes.push("HOLDER_CONCENTRATION");
    category = elevate(category, "REVIEW");
  }
  if (holderConcentration !== null && d(holderConcentration).gte("80")) {
    category = elevate(category, "BLOCK");
  }
  if (liquidityFragile === true) {
    reasonCodes.push("LIQUIDITY_FRAGILE");
    category = elevate(category, "REVIEW");
  }
  if (suspiciousDeployer === true) {
    reasonCodes.push("SECURITY_REVIEW");
    category = elevate(category, "REVIEW");
  }
  if (largeWalletMove === true) {
    reasonCodes.push("SECURITY_REVIEW");
    category = elevate(category, "REVIEW");
  }

  if (category === "PASS") reasonCodes.push("SECURITY_PASS");
  else if (category === "REVIEW" && !reasonCodes.includes("SECURITY_REVIEW")) reasonCodes.push("SECURITY_REVIEW");
  else if (category === "BLOCK" && !reasonCodes.includes("SECURITY_BLOCK")) reasonCodes.push("SECURITY_BLOCK");

  const confidence =
    category === "PASS" ? "0.850000" : category === "BLOCK" ? "0.950000" : category === "REVIEW" ? "0.700000" : "0.000000";

  return {
    tokenAddress: input.tokenAddress,
    category,
    confidence,
    reasonCodes,
    mintAuthority,
    freezeAuthority,
    transferRestricted,
    token2022Extensions: token2022,
    holderConcentrationTop10Pct: holderConcentration,
    suspiciousDeployer,
    liquidityFragile,
    largeWalletMove,
    fraudIndicators,
    source: "birdeye",
    fetchedAt: input.security.fetchedAt,
    stale: false,
    fields,
  };
}

function concentrationFromHolders(holders: Extract<HolderProviderPayload, { ok: true }>): string | null {
  const top = holders.fields.top10HolderPercent ?? holders.fields.top10Percent ?? holders.fields.top10;
  if (typeof top === "number") return d(String(top)).toFixed(6);
  if (typeof top === "string") {
    try {
      return d(top).toFixed(6);
    } catch {
      return null;
    }
  }
  return null;
}

export function runAegis(input: {
  pair: CyclePair;
  assessment: SecurityAssessment | null;
  hasIntent: boolean;
  side: "BUY" | "SELL" | null;
}): AegisVerdict {
  const started = Date.now();
  const assessment =
    input.assessment ??
    unknownAssessment(input.pair.baseAddress, "unavailable", new Date(), ["SECURITY_UNKNOWN", "UPSTREAM_UNAVAILABLE"]);

  // UNKNOWN ≠ PASS. Unavailable provider does not hard-block paper entries; BLOCK/REVIEW do.
  const blocksEntry =
    input.side === "BUY" && (assessment.category === "BLOCK" || assessment.category === "REVIEW");

  let decision: DecisionDraft["decision"] = "PASS";
  const reasons: ReasonCode[] = [...assessment.reasonCodes];
  if (!input.hasIntent) {
    decision = "HOLD";
    reasons.length = 0;
    reasons.push("NO_INTENT");
  } else if (input.side === "SELL") {
    decision = "PASS";
    if (assessment.category === "UNKNOWN") reasons.push("SECURITY_UNKNOWN");
  } else if (assessment.category === "PASS") {
    decision = "PASS";
  } else if (assessment.category === "UNKNOWN") {
    decision = "HOLD";
    if (!reasons.includes("SECURITY_UNKNOWN")) reasons.push("SECURITY_UNKNOWN");
  } else if (assessment.category === "REVIEW" || assessment.category === "BLOCK") {
    decision = "REJECT";
  }

  return {
    assessment,
    blocksEntry,
    decision: {
      agent: "AEGIS",
      modelVersion: MODEL_VERSIONS.AEGIS,
      pairAddress: input.pair.pairAddress,
      decision,
      confidence: assessment.confidence,
      reasonCodes: reasons,
      input: {
        observationId: input.pair.observationId,
        tokenAddress: input.pair.baseAddress,
        securitySource: assessment.source,
        category: assessment.category,
      },
      output: {
        category: assessment.category,
        blocksEntry,
        mintAuthority: assessment.mintAuthority,
        freezeAuthority: assessment.freezeAuthority,
        holderConcentrationTop10Pct: assessment.holderConcentrationTop10Pct,
        advisory: null,
      },
      inputSource: assessment.source === "unavailable" ? "security:unavailable" : `security:${assessment.source}`,
      durationMs: Date.now() - started,
    },
  };
}

export function unknownAssessment(
  tokenAddress: string,
  source: SecurityAssessment["source"],
  now: Date,
  reasonCodes: ReasonCode[],
): SecurityAssessment {
  return {
    tokenAddress,
    category: "UNKNOWN",
    confidence: confidenceFixed(new Decimal(0)),
    reasonCodes,
    mintAuthority: "unknown",
    freezeAuthority: "unknown",
    transferRestricted: null,
    token2022Extensions: null,
    holderConcentrationTop10Pct: null,
    suspiciousDeployer: null,
    liquidityFragile: null,
    largeWalletMove: null,
    fraudIndicators: [],
    source,
    fetchedAt: null,
    stale: source === "cached",
    fields: {},
  };
}

function elevate(current: SecurityCategory, next: SecurityCategory): SecurityCategory {
  const rank: Record<SecurityCategory, number> = { PASS: 0, REVIEW: 1, UNKNOWN: 2, BLOCK: 3 };
  return rank[next] > rank[current] ? next : current;
}

function authorityState(
  fields: Record<string, string | number | boolean | null>,
  keys: string[],
): "present" | "revoked" | "unknown" {
  for (const key of keys) {
    const value = fields[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "boolean") return value ? "present" : "revoked";
    if (typeof value === "string") {
      if (value === "" || value.toLowerCase() === "null" || value === "11111111111111111111111111111111") return "revoked";
      return "present";
    }
  }
  return "unknown";
}

function boolField(fields: Record<string, string | number | boolean | null>, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.toLowerCase() === "true") return true;
      if (value.toLowerCase() === "false") return false;
    }
    if (typeof value === "number") return value > 0;
  }
  return null;
}

function stringList(fields: Record<string, string | number | boolean | null>, keys: string[]): string[] | null {
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === "string" && value.length > 0) return value.split(",").map((part) => part.trim()).filter(Boolean);
  }
  return null;
}

function isStale(assessment: SecurityAssessment, now: Date, maxAgeMs: number): boolean {
  if (!assessment.fetchedAt) return true;
  const fetched = Date.parse(assessment.fetchedAt);
  if (!Number.isFinite(fetched)) return true;
  return now.getTime() - fetched > maxAgeMs;
}
