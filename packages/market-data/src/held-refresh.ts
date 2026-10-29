import type { NormalizedPair } from "@odin/shared";
import { parseDexPair, dexscreenerTokensUrl } from "./dexscreener.js";
import type { InstrumentQuote } from "./market-provider.js";
import type { ProviderResult } from "./provider.js";

/**
 * Independent refresh for held / pending / protected instruments (R02 / D08).
 * Discovery universe is NOT sufficient — marks for open risk must be fetched
 * even when the instrument left the discovery set. Provider outages must not
 * pretend old stored marks are fresh.
 *
 * Routes by instrument prefix; pair lookups use fairness rotation (no silent drop);
 * all fetches honour abort deadlines.
 */

export type MandatoryMarkTarget = {
  pairAddress: string;
  /** Solana base mint when known — used for DexScreener tokens endpoint. */
  baseAddress?: string | null;
};

export type HeldProviderRoute = "solana_dex" | "fx" | "etf" | "commodity" | "index" | "unknown";

export type FairnessCursor = {
  /** Rotating offset into the still-missing pair-address lookup queue. */
  pairLookupOffset: number;
};

export type HeldRefreshCoverage = {
  pairAddress: string;
  route: HeldProviderRoute;
  refreshed: boolean;
  lastSuccessAt: string | null;
};

export type MandatoryRefreshResult = ProviderResult<NormalizedPair[]> & {
  missing: string[];
  fetchedAddresses: string[];
  coverage: HeldRefreshCoverage[];
  fairness: FairnessCursor;
  /** Targets deferred this cycle by the fair pair-lookup budget (will rotate next). */
  deferredPairLookups: string[];
};

const DEFAULT_PAIR_LOOKUP_BUDGET = 20;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

export function routeHeldTarget(pairAddress: string): HeldProviderRoute {
  if (pairAddress.startsWith("fx:")) return "fx";
  if (pairAddress.startsWith("etf:") || pairAddress.startsWith("equity:")) return "etf";
  if (pairAddress.startsWith("commodity:")) return "commodity";
  if (pairAddress.startsWith("index:")) return "index";
  if (pairAddress.includes(":")) return "unknown";
  return "solana_dex";
}

/**
 * Fair rotating window — every item eventually selected; no silent permanent drop past `limit`.
 */
export function selectFairSlice<T>(
  items: readonly T[],
  limit: number,
  offset: number,
): { selected: T[]; nextOffset: number; deferred: T[] } {
  if (items.length === 0) return { selected: [], nextOffset: 0, deferred: [] };
  if (limit <= 0) return { selected: [], nextOffset: offset % items.length, deferred: [...items] };
  if (items.length <= limit) {
    return { selected: [...items], nextOffset: 0, deferred: [] };
  }
  const start = ((offset % items.length) + items.length) % items.length;
  const selected: T[] = [];
  for (let i = 0; i < limit; i += 1) {
    selected.push(items[(start + i) % items.length]!);
  }
  const selectedSet = new Set(selected);
  const deferred = items.filter((item) => !selectedSet.has(item));
  return {
    selected,
    nextOffset: (start + limit) % items.length,
    deferred,
  };
}

export function createAbortDeadline(
  timeoutMs: number,
  parent?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("HELD_REFRESH_DEADLINE")), timeoutMs);
  const onParentAbort = () => controller.abort(parent?.reason ?? new Error("HELD_REFRESH_PARENT_ABORT"));
  if (parent) {
    if (parent.aborted) onParentAbort();
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      if (parent) parent.removeEventListener("abort", onParentAbort);
    },
  };
}

/** Convert a gateway InstrumentQuote into a NormalizedPair for worker ingest. */
export function instrumentQuoteToNormalizedPair(quote: InstrumentQuote): NormalizedPair | null {
  if (quote.level === null || quote.level === undefined) return null;
  const level = Number(quote.level);
  if (!Number.isFinite(level) || !(level > 0)) return null;
  const [prefix, rest] = quote.instrumentId.split(":");
  const route = routeHeldTarget(quote.instrumentId);
  const chainId: NormalizedPair["chainId"] =
    route === "fx"
      ? "fx"
      : route === "etf"
        ? "equity"
        : route === "commodity"
          ? "commodity"
          : route === "index"
            ? "equity"
            : "solana";
  const source: NormalizedPair["source"] =
    route === "fx"
      ? "fx_stub"
      : route === "etf"
        ? "etf_stub"
        : route === "commodity"
          ? "commodity_stub"
          : route === "index"
            ? "index_stub"
            : "dexscreener";
  return {
    source,
    chainId,
    pairAddress: quote.instrumentId,
    dexId: quote.providerId,
    url: null,
    baseAddress: rest?.slice(0, 6) ?? quote.symbol,
    baseSymbol: quote.symbol,
    baseName: quote.symbol,
    quoteAddress: quote.currency,
    quoteSymbol: quote.currency,
    priceUsd: quote.level,
    liquidityUsd: null,
    volume24hUsd: null,
    volume5mUsd: null,
    priceChangeM5Pct: null,
    priceChangeH1Pct: null,
    priceChangeH24Pct: null,
    txnsM5Buys: null,
    txnsM5Sells: null,
    pairCreatedAt: null,
    fdvUsd: null,
    marketCapUsd: null,
    raw: {
      provenance: quote.provenance,
      dataState: quote.dataState,
      bid: quote.bid ?? null,
      ask: quote.ask ?? null,
      eventTime: quote.eventTime ?? null,
      receivedAt: quote.receivedAt,
      providerId: quote.providerId,
      heldRefresh: true,
      routePrefix: prefix ?? null,
    },
  };
}

export type FetchQuotesFn = (
  instrumentIds: string[],
  signal: AbortSignal,
) => Promise<ProviderResult<InstrumentQuote[]>>;

/**
 * Full mandatory refresh: Solana via DexScreener + non-Solana via injected quote router.
 * Prefer calling this instead of awaiting discovery first in the worker observe stage.
 */
export async function fetchMandatoryMarks(options: {
  targets: MandatoryMarkTarget[];
  fetchImpl?: typeof fetch;
  now?: Date;
  /** Per-request abort deadline (ms). */
  timeoutMs?: number;
  /** Parent abort (e.g. cycle cancelled). */
  signal?: AbortSignal;
  /** Max direct pair-address lookups this cycle (fairness rotates the rest). */
  pairLookupBudget?: number;
  fairness?: FairnessCursor;
  /** Optional multi-market quote fetcher (MarketDataGateway). */
  fetchQuotes?: FetchQuotesFn;
  /** Last known success timestamps by pair (coverage debt tracking). */
  lastSuccessByPair?: Record<string, string | null | undefined>;
}): Promise<MandatoryRefreshResult> {
  const fetchedAt = (options.now ?? new Date()).toISOString();
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pairLookupBudget = options.pairLookupBudget ?? DEFAULT_PAIR_LOOKUP_BUDGET;
  const fairness: FairnessCursor = {
    pairLookupOffset: options.fairness?.pairLookupOffset ?? 0,
  };
  const lastSuccessByPair = options.lastSuccessByPair ?? {};
  const fetchImpl = options.fetchImpl ?? fetch;

  const byRoute = new Map<HeldProviderRoute, MandatoryMarkTarget[]>();
  for (const target of options.targets) {
    const route = routeHeldTarget(target.pairAddress);
    const list = byRoute.get(route) ?? [];
    list.push(target);
    byRoute.set(route, list);
  }

  const byAddress = new Map<string, NormalizedPair>();
  const errors: string[] = [];
  let nextFairness = fairness.pairLookupOffset;
  let deferredPairLookups: string[] = [];

  const solanaTargets = byRoute.get("solana_dex") ?? [];
  if (solanaTargets.length > 0) {
    const solana = await refreshSolanaTargets({
      targets: solanaTargets,
      fetchImpl,
      timeoutMs,
      parentSignal: options.signal,
      pairLookupBudget,
      fairnessOffset: fairness.pairLookupOffset,
    });
    if (!solana.ok) {
      errors.push(solana.error);
    } else {
      for (const pair of solana.data) byAddress.set(pair.pairAddress, pair);
    }
    nextFairness = solana.nextOffset;
    deferredPairLookups = solana.deferred;
  }

  const multiRoutes: HeldProviderRoute[] = ["fx", "etf", "commodity", "index"];
  const multiTargets = multiRoutes.flatMap((route) => byRoute.get(route) ?? []);
  if (multiTargets.length > 0) {
    if (!options.fetchQuotes) {
      // No router injected — report missing rather than inventing; do not claim Solana handled them.
      errors.push("MULTI_MARKET_ROUTER_UNAVAILABLE");
    } else {
      const deadline = createAbortDeadline(timeoutMs, options.signal);
      try {
        const ids = multiTargets.map((t) => t.pairAddress);
        const quotes = await options.fetchQuotes(ids, deadline.signal);
        if (!quotes.ok) {
          errors.push(quotes.error);
        } else {
          for (const quote of quotes.data) {
            const pair = instrumentQuoteToNormalizedPair(quote);
            if (pair) byAddress.set(pair.pairAddress, pair);
          }
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "multi-market refresh failed");
      } finally {
        deadline.dispose();
      }
    }
  }

  const unknownTargets = byRoute.get("unknown") ?? [];

  const coverage: HeldRefreshCoverage[] = options.targets.map((target) => {
    const refreshed = byAddress.has(target.pairAddress);
    return {
      pairAddress: target.pairAddress,
      route: routeHeldTarget(target.pairAddress),
      refreshed,
      lastSuccessAt: refreshed ? fetchedAt : (lastSuccessByPair[target.pairAddress] ?? null),
    };
  });

  const data = options.targets
    .map((t) => byAddress.get(t.pairAddress))
    .filter((p): p is NormalizedPair => Boolean(p));
  const fetchedAddresses = data.map((p) => p.pairAddress);
  const missing = [
    ...options.targets.filter((t) => !byAddress.has(t.pairAddress)).map((t) => t.pairAddress),
    ...unknownTargets.map((t) => t.pairAddress).filter((addr) => !byAddress.has(addr)),
  ];
  // Dedupe missing
  const missingUnique = [...new Set(missing)];

  if (data.length === 0 && options.targets.length > 0 && errors.length > 0 && solanaTargets.length === options.targets.length) {
    return {
      ok: false,
      code: "UPSTREAM",
      error: errors.join("; "),
      missing: missingUnique,
      fetchedAddresses: [],
      coverage,
      fairness: { pairLookupOffset: nextFairness },
      deferredPairLookups,
    };
  }

  return {
    ok: true,
    fetchedAt,
    data,
    missing: missingUnique,
    fetchedAddresses,
    coverage,
    fairness: { pairLookupOffset: nextFairness },
    deferredPairLookups,
  };
}

/**
 * @deprecated Prefer {@link fetchMandatoryMarks}. Solana-only path retained for callers.
 */
export async function fetchMandatorySolanaMarks(options: {
  targets: MandatoryMarkTarget[];
  fetchImpl?: typeof fetch;
  now?: Date;
  timeoutMs?: number;
  signal?: AbortSignal;
  pairLookupBudget?: number;
  fairness?: FairnessCursor;
}): Promise<
  ProviderResult<NormalizedPair[]> & {
    missing: string[];
    fetchedAddresses: string[];
  }
> {
  const result = await fetchMandatoryMarks({
    ...options,
    // Explicitly do not fetch multi-market here — mark them missing like the legacy behaviour,
    // but still classify them (legacy returned multi-market as missing).
  });
  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      error: result.error,
      missing: result.missing,
      fetchedAddresses: result.fetchedAddresses,
    };
  }
  return {
    ok: true,
    fetchedAt: result.fetchedAt,
    data: result.data,
    missing: result.missing,
    fetchedAddresses: result.fetchedAddresses,
  };
}

async function refreshSolanaTargets(input: {
  targets: MandatoryMarkTarget[];
  fetchImpl: typeof fetch;
  timeoutMs: number;
  parentSignal?: AbortSignal;
  pairLookupBudget: number;
  fairnessOffset: number;
}): Promise<
  | {
      ok: true;
      data: NormalizedPair[];
      nextOffset: number;
      deferred: string[];
    }
  | {
      ok: false;
      error: string;
      nextOffset: number;
      deferred: string[];
      data: NormalizedPair[];
    }
> {
  const byAddress = new Map<string, NormalizedPair>();
  const mints = [
    ...new Set(
      input.targets
        .map((t) => t.baseAddress)
        .filter((m): m is string => typeof m === "string" && m.length > 20),
    ),
  ];

  let mintFetchFailed: string | null = null;
  if (mints.length > 0) {
    for (let i = 0; i < mints.length; i += 30) {
      const chunk = mints.slice(i, i + 30);
      const deadline = createAbortDeadline(input.timeoutMs, input.parentSignal);
      try {
        const result = await readJson(input.fetchImpl, dexscreenerTokensUrl(chunk), deadline.signal);
        if (!result.ok) {
          mintFetchFailed = result.error;
          break;
        }
        const list = extractPairs(result.body);
        for (const item of list ?? []) {
          const parsed = parseDexPair(item);
          if (parsed) byAddress.set(parsed.pairAddress, parsed);
        }
      } finally {
        deadline.dispose();
      }
    }
  }

  if (mintFetchFailed && byAddress.size === 0 && mints.length === input.targets.length) {
    return {
      ok: false,
      error: mintFetchFailed,
      nextOffset: input.fairnessOffset,
      deferred: [],
      data: [],
    };
  }

  const stillMissing = input.targets.filter((t) => !byAddress.has(t.pairAddress));
  const slice = selectFairSlice(stillMissing, input.pairLookupBudget, input.fairnessOffset);

  for (const target of slice.selected) {
    const deadline = createAbortDeadline(input.timeoutMs, input.parentSignal);
    try {
      const url = `https://api.dexscreener.com/latest/dex/pairs/solana/${target.pairAddress}`;
      const result = await readJson(input.fetchImpl, url, deadline.signal);
      if (!result.ok) continue;
      const list = extractPairs(result.body);
      for (const item of list ?? []) {
        const parsed = parseDexPair(item);
        if (parsed) byAddress.set(parsed.pairAddress, parsed);
      }
    } finally {
      deadline.dispose();
    }
  }

  return {
    ok: true,
    data: [...byAddress.values()],
    nextOffset: slice.nextOffset,
    deferred: slice.deferred.map((t) => t.pairAddress),
  };
}

async function readJson(
  fetchImpl: typeof fetch,
  url: string,
  signal?: AbortSignal,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  try {
    const fetchPromise = fetchImpl(url, {
      headers: { accept: "application/json" },
      signal,
    });
    // Also race the deadline: injected fetchImpls may ignore AbortSignal.
    const response = signal
      ? await Promise.race([
          fetchPromise,
          new Promise<never>((_, reject) => {
            const fail = () => reject(new Error("HELD_REFRESH_DEADLINE"));
            if (signal.aborted) fail();
            else signal.addEventListener("abort", fail, { once: true });
          }),
        ])
      : await fetchPromise;
    if (!response.ok) return { ok: false, error: `HTTP ${response.status} for ${url}` };
    return { ok: true, body: await response.json() };
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    if (signal?.aborted || message.includes("HELD_REFRESH_DEADLINE")) {
      return { ok: false, error: `ABORTED: ${message}` };
    }
    return { ok: false, error: message };
  }
}

function extractPairs(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const row = body as { pairs?: unknown; pair?: unknown };
    if (Array.isArray(row.pairs)) return row.pairs;
    if (row.pair) return [row.pair];
  }
  return null;
}
