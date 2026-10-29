import type { DataOrigin, TradingEnvironment } from "./environments.js";
import { assertEnvironmentIsolation, DATA_ORIGINS } from "./environments.js";
import type { DataState } from "./freshness.js";

/**
 * Typed observation provenance helpers (R09).
 * Validate each row's actual origin — never label all paperExtras as FIXTURE_SEQUENCE.
 */

export type ObservationProvenance = {
  dataOrigin: DataOrigin;
  freshnessHint: DataState | null;
  eventTime: string | null;
  providerId: string | null;
};

export function parseDataOrigin(value: unknown): DataOrigin | null {
  if (typeof value !== "string") return null;
  return (DATA_ORIGINS as readonly string[]).includes(value) ? (value as DataOrigin) : null;
}

/**
 * Infer provenance from NormalizedPair.raw / source / stored columns.
 * Daily FX reference rates (Frankfurter) are DELAYED_FEED valuation inputs — not fixtures.
 */
export function inferObservationProvenance(input: {
  source: string;
  freshness?: string | null;
  dataOrigin?: string | null;
  raw?: unknown;
}): ObservationProvenance {
  const raw =
    input.raw && typeof input.raw === "object" && !Array.isArray(input.raw)
      ? (input.raw as Record<string, unknown>)
      : null;
  const fromRaw = parseDataOrigin(raw?.dataOrigin ?? input.dataOrigin);
  const providerId =
    typeof raw?.providerId === "string"
      ? raw.providerId
      : typeof raw?.provenance === "string"
        ? raw.provenance
        : null;
  const eventTime =
    typeof raw?.eventTime === "string"
      ? raw.eventTime
      : typeof raw?.receivedAt === "string"
        ? raw.receivedAt
        : null;

  if (fromRaw) {
    const freshnessHint: DataState | null =
      fromRaw === "FIXTURE_SEQUENCE" || fromRaw === "PROVIDER_DEMO"
        ? "DEMO"
        : fromRaw === "REPLAY_STORE"
          ? "REPLAY"
          : fromRaw === "DELAYED_FEED"
            ? "DELAYED"
            : fromRaw === "LIVE_FEED" || fromRaw === "SANDBOX_BROKER"
              ? "LIVE"
              : null;
    return { dataOrigin: fromRaw, freshnessHint, eventTime, providerId };
  }

  if (input.freshness === "DEMO" || input.source === "replay") {
    const origin: DataOrigin =
      input.source === "replay" ? "REPLAY_STORE" : "FIXTURE_SEQUENCE";
    return {
      dataOrigin: origin,
      freshnessHint: input.source === "replay" ? "REPLAY" : "DEMO",
      eventTime,
      providerId,
    };
  }

  if (
    providerId === "frankfurter_fx" ||
    (typeof raw?.dataState === "string" && raw.dataState === "DELAYED") ||
    (typeof raw?.provenance === "string" &&
      (raw.provenance === "DELAYED" || raw.provenance.toLowerCase().includes("frankfurter")))
  ) {
    return { dataOrigin: "DELAYED_FEED", freshnessHint: "DELAYED", eventTime, providerId };
  }

  if (input.source === "dexscreener" || input.source === "birdeye") {
    return { dataOrigin: "LIVE_FEED", freshnessHint: "LIVE", eventTime, providerId };
  }

  // Stub sources without explicit delayed provenance stay DEMO (fixture/paper stubs).
  if (
    input.source === "fx_stub" ||
    input.source === "etf_stub" ||
    input.source === "index_stub" ||
    input.source === "commodity_stub"
  ) {
    return { dataOrigin: "FIXTURE_SEQUENCE", freshnessHint: "DEMO", eventTime, providerId };
  }

  return { dataOrigin: "LIVE_FEED", freshnessHint: null, eventTime, providerId };
}

/** Per-row isolation check — failures are scoped to that provider/row, not the whole cycle. */
export function checkRowEnvironmentIsolation(
  provenance: ObservationProvenance,
  accountEnvironment: TradingEnvironment,
): { ok: true } | { ok: false; reason: string } {
  return assertEnvironmentIsolation(provenance.dataOrigin, accountEnvironment);
}

/**
 * Resolve planning freshness for a stored observation.
 * DELAYED_FEED / frankfurter must remain DELAYED — never force DEMO solely because source=fx_stub.
 */
export function freshnessFromProvenance(
  provenance: ObservationProvenance,
  classified: DataState,
): DataState {
  if (provenance.dataOrigin === "DELAYED_FEED") return "DELAYED";
  if (provenance.dataOrigin === "FIXTURE_SEQUENCE" || provenance.dataOrigin === "PROVIDER_DEMO") {
    return "DEMO";
  }
  if (provenance.dataOrigin === "REPLAY_STORE") return "REPLAY";
  if (provenance.freshnessHint && provenance.freshnessHint !== "LIVE") {
    return provenance.freshnessHint;
  }
  return classified;
}
