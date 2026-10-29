import type { DataState } from "./freshness.js";
import { findInstrument } from "./instruments.js";
import { productSemanticsFor } from "./product-semantics.js";
import { evaluateSession, type SessionEval } from "./sessions.js";

/**
 * Held-position mark merge outside the discovery/ingest snapshot (A04).
 * Pure helper mirroring worker loadPlan behaviour for multi-market instruments.
 */

export type HeldObservationMark = {
  pairAddress: string;
  priceUsd: string | null;
  freshness: DataState;
  receivedAt: string;
};

export type HeldMarkMergeInput = {
  /** Pair addresses present in the current discovery/ingest snapshot. */
  discoveryAddresses: Iterable<string>;
  /** Open held positions (qty > 0 implied by caller). */
  heldPositions: Array<{ pairAddress: string; baseQty: string }>;
  /** Latest observation per held pair (may be absent). */
  latestByPair: Record<string, HeldObservationMark | undefined>;
  now: Date;
};

export type HeldMarkRow = {
  pairAddress: string;
  instrumentId: string | null;
  priceUsd: string | null;
  freshness: DataState | "MISSING";
  /** True when the mark came from outside the discovery snapshot. */
  outsideDiscovery: boolean;
  session: SessionEval | null;
  productLabel: string | null;
  executionSupported: boolean | null;
  markUsableForEval: boolean;
};

/**
 * For each held position not in discovery, attach the latest mark if present.
 * Missing marks stay MISSING — never invent prices. Multi-market instruments
 * also carry session + product semantics for honest exit/eval gating.
 */
export function mergeHeldMarksOutsideDiscovery(input: HeldMarkMergeInput): HeldMarkRow[] {
  const discovery = new Set(input.discoveryAddresses);
  const rows: HeldMarkRow[] = [];
  for (const position of input.heldPositions) {
    const outsideDiscovery = !discovery.has(position.pairAddress);
    const latest = input.latestByPair[position.pairAddress];
    const instrument =
      findInstrument(position.pairAddress) ??
      (position.pairAddress.includes(":") ? findInstrument(position.pairAddress) : undefined);
    const semantics = productSemanticsFor(position.pairAddress);
    const session =
      instrument != null ? evaluateSession({ session: instrument.session, now: input.now }) : null;
    const priceUsd = latest?.priceUsd ?? null;
    const freshness: DataState | "MISSING" =
      latest && priceUsd !== null ? latest.freshness : "MISSING";
    rows.push({
      pairAddress: position.pairAddress,
      instrumentId: instrument?.id ?? (position.pairAddress.includes(":") ? position.pairAddress : null),
      priceUsd,
      freshness,
      outsideDiscovery,
      session,
      productLabel: semantics?.productLabel ?? null,
      executionSupported: semantics?.executionSupported ?? null,
      markUsableForEval: freshness !== "MISSING" && priceUsd !== null,
    });
  }
  return rows;
}

/** Positions that must still be evaluated even though they left discovery. */
export function heldOutsideDiscovery(rows: HeldMarkRow[]): HeldMarkRow[] {
  return rows.filter((row) => row.outsideDiscovery);
}
