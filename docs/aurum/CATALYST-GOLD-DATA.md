# CATALYST: gold historical data, warehouse and feed quality

18 Nov 2026. No provider request was made in this operation. Facts are labelled by source.

## 1. OANDA v20 candle capabilities

| Property | Value | Source |
| --- | --- | --- |
| Endpoint | `GET /v3/instruments/{instrument}/candles` | repo adapter `oanda-practice.ts`; OANDA v20 reference (page unreachable to the fetcher: HTTP 404) |
| Price components | `M` (mid), `B` (bid), `A` (ask), combinable (`MBA`) | repo adapter (requests `MBA`); third-party v20 client docs |
| Maximum per request | `count` default 500, **maximum 5,000**; `count` must not be combined with both `from` and `to` | repo adapter clamps to 5,000; v20 client docs |
| Completion | each candle has `complete`; the in-progress candle is `false` | repo parser `complete: row.complete === true`; source skips incomplete candles and stops a page walk at one |
| Daily alignment | `dailyAlignment` 0–23 (default 17), `alignmentTimezone` (default America/New_York); weekly alignment separate | v20 docs as summarised by third parties; repo uses 17 / New York for `oanda_practice_ny17` and 0 / UTC intraday |
| Granularities in the v20 API | S5, S10, S15, S30, M1, M2, M4, M5, M10, M15, M30, H1, H2, H3, H4, H6, H8, H12, D, W, M | v20 API (secondary sources); **the repo adapter supports only M1, M5, M15, M30, H1, H4, D** |
| Empty intervals | no candle is returned for an interval with no ticks (gaps are normal around rollover and thin hours) | v20 behaviour (secondary); consistent with repo `findGaps` closed-session semantics |
| Pagination | walk forward with `from` = last open + interval; the repo stops on a short page, the window end or an incomplete candle | `history/sources.ts` |
| Rate guidance | at most 100 requests per second on an established connection, and 2 new connections per second (recommendation, not an enforced limit) | OANDA v20 best-practices page (fetched) |
| Historical spread | not a separate series: derived from bid/ask candle closes (`spread_c` is already stored per bar) | repo `sources.ts` |
| Licensing | "OANDA practice account terms; for the account holder's own use; no redistribution" | repo source descriptor (`terms`); the actual terms are not re-read here |

**History depth per granularity, and whether this practice account receives S5 data, are UNVERIFIED.** The only evidence is in the existing datasets:
- 1d data from 2016-11-01;
- 1h data from 2024-11-01 (the requested start, not necessarily the earliest available).

Nothing establishes how far back M1 or S5 go.

## 2. Availability matrix

| Granularity | Adapter support | Earliest known | Held in warehouse | Status |
| --- | --- | --- | --- | --- |
| S5 | no (needs an additive adapter change) | unknown | no | UNVERIFIED; probe needed |
| M1 | yes | unknown | no | UNVERIFIED; probe needed |
| M5 / M15 / M30 | yes | unknown | no | UNVERIFIED |
| H1 | yes | ≤ 2024-11-01 (requested start) | 11,904 bars to 2026-11-06 | VERIFIED_PRODUCTION (D8) |
| H4 | yes | unknown | no | UNVERIFIED |
| D (NY 17:00) | yes | ≤ 2016-11-01 | 2,602 bars to 2026-11-04 | VERIFIED_PRODUCTION |
| D (UTC) | refused by the current source (Sunday stub) | ≤ 2016-11-01 | 3,112 bars (legacy) | VERIFIED_PRODUCTION |

**Earliest-history probe (D17; read-only to OANDA; about 8 requests; not approved):** for each granularity G in M1, M5, M15, M30, H1, H4 and D:
- `candles?granularity=G&price=MBA&from=2005-01-01T00:00:00Z&count=1`;
- record the first returned candle time, `complete` and whether bid and ask are present;
- store nothing.

S5 needs a one-line additive adapter change first and is listed separately. Running the probe needs the practice token on the VPS (`OandaPracticeMarketData`), not on this host.

## 3. Acquisition plan (bounded; not executed)

1. **Probe (D17).** Establish the earliest M1 date.
2. **Register the research snapshot boundary and holdout window first.** The refresh must never extend or alter a pinned dataset. A new interval or range is a new dataset identity: source id + interval + range + `versionHash`.
3. **M1 bid/ask back-fill:**
   - use the existing `backfill-cli`, `ensureBackfillJob` and `PrismaBackfillStore` (checkpointed, append-only, with revision and rejection recording);
   - one interval per process, at most 20 requests per invocation and 30 requests a minute;
   - start with one approved pre-holdout month and check completeness against the metals calendar before expanding.
   - **Size:** gold trades about 23 h × 5 days, so about 6,900 M1 bars a week and about 355,000 a year. At 5,000 per request, ten years is about 3.6 M bars and 720 requests, about 25 minutes at 30 requests a minute.
   - **Storage:** about 1.2–1.8 GB for ten years (UNVERIFIED: estimated from about 350–500 B per `HistoricalBar` row with MBA extras plus raw batch), against 44 GB free.
4. **Derive higher timeframes from canonical M1** with `history/aggregate.ts`, as distinct dataset identities. Keep the native H1 and D datasets, and compare native with aggregated output:
   - OHLC should match exactly when no M1 inside the bucket was missing or incomplete;
   - every difference is recorded, never reconciled by overwriting.
5. **S5:** not recommended now.
   - It needs about 12 times the M1 storage: about 15–20 GB for ten years, a third of free disk.
   - It adds little to research at the intended holding periods.
   - Its main use, sub-minute spread and latency modelling, is better served by the live shadow feed.
   - Reconsider after retention and dump policy free space, and only for a bounded recent window.

No external data is purchased. Missing candles are never fabricated. Sealed holdouts are not read: acquisition writes new bars and evaluates nothing.

## 4. Warehouse capabilities: what exists and what CATALYST added

| Capability | Status |
| --- | --- |
| Resumable, checkpointed pagination; dedup; append-only bars; revision and rejection records; request budget; dataset hash | **exists** (`history/*`, `backfill-cli`) |
| Provider provenance per bar (`priceComponents`, tick volume, bid/ask OHLC, `spread_c`) | exists |
| Candle completeness (`complete` filter), OHLC validation, gap detection with closed-session semantics | exists (`integrity.ts` `findGaps`, `quality.ts` `gapSemanticsFor`) |
| Availability timestamps (`availableAt` = close) | exists |
| **Deterministic aggregation from canonical M1** | **added**: `history/aggregate.ts` (5 tests). Exact decimals; bid/ask only when every member has them; availability = max(bucket end, member availability); a completeness flag against a caller calendar; refuses unordered, misaligned or invalid input |
| Rate limiting and retry budgets | per-invocation request cap exists; a cross-process provider limiter is not verified |
| Storage capacity reporting | not built: use the D14 queries; a scheduled report is a follow-up |
| Operational observations kept apart from research datasets | yes by table (`MarketObservation` vs `HistoricalDataset`/`HistoricalBar`). Shadow-quote persistence needs a new immutable table (TITANIUM D11, protected schema) |

No schema change is needed for M1 acquisition: `HistoricalBar` already holds MBA extras.

## 5. Shadow feed quality

- **Added:** `gold-quote-tiers.ts` (5 tests). It defines four tiers (REFERENCE_INGEST, SHADOW_RESEARCH, PAPER_ENTRY, PAPER_EXIT), each with its own spread, age, session and tradeability rules.
- **No default thresholds.** The proposed 10 bps is not adopted.
- **The validator enforces the ordering:**
  - entry is no looser than research, and research no looser than ingest;
  - the exit cap is never tighter than entry, so a protective exit is never blocked by an entry rule;
  - entry requires an open session and a tradeable instrument.
- **`spreadStatistics` and `spreadByNewYorkHour`** report spread percentiles (p50, p90, p95, p99, max, mean) in points, basis points and round-trip £ per £/point stake.
- **Measuring without polling:** fed with M1 bid/ask candle closes, these give a historical spread distribution by hour. The rollover and Asian hours are expected to be much wider than the 6 Nov 1.2 bps sample.

**Recommendation for thresholds** (to set after the M1 bid/ask month in §3.3, not before):

| Tier | Spread cap | Age | Session / tradeable |
| --- | --- | --- | --- |
| PAPER_ENTRY | p75–p90 of the in-session distribution for the hours the strategy trades | ≤ 2 polling intervals | both required |
| PAPER_EXIT | at least p99, and never below entry | longer | not required, but flagged |
| SHADOW_RESEARCH | p99 | — | session required |
| REFERENCE_INGEST | a sanity bound only, for example 10× the p99 | — | — |

**Cost of the spread:** the simulated round trip pays the spread once, so £/point × spread points. At the generic £0.50/point minimum stake:
- a 0.30-point spread costs £0.15;
- a 1.00-point spread costs £0.50.

These are worked examples, not measurements.

**Polling vs streaming:**
- The shadow feed polls the existing allow-listed host `api-fxpractice.oanda.com` (default 5 s, single request in flight, circuit breaker with generation fence).
- OANDA's pricing stream would need a new allow-listed host (`stream-fxpractice.oanda.com`, UNVERIFIED here) and a long-lived connection with heartbeat supervision.
- At 5 s polling, about 17,000 requests a day are needed, far inside the 100 per second guidance.
- Recommendation: keep polling for shadow research. Consider streaming only when an execution-latency model needs sub-second quotes.

**Persistence:** still not implemented, by design. Durable shadow quotes need the immutable `GoldShadowQuote` table, a protected schema change (D11). Until then the feed is in-memory and bounded.
