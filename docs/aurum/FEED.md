# AURUM gold reference feed: TITANIUM architecture

Date: 2026-11-17. State: IMPLEMENTED_INACTIVE, SHADOW_ONLY; execution eligibility is always false. This document proposes operation; it does not approve activation, threshold values, provider calls, storage budgets or schema changes.

## Evidence and transport decision

VERIFIED_REPOSITORY: branch `aurum/03-market-data` at `0cc864c` implements a bounded in-memory `GoldShadowFeed`, requesting exactly `XAU_USD` through the separate read-only `OandaPracticeMarketData` pricing client. No worker schedule or durable quote sink is wired. The order-capable `OandaPracticeProvider` is not the feed's transport and must not be passed through the shadow interface.

Authoritative public-documentation evidence checked 17 November: OANDA documents practice REST and streaming servers. Pricing streams provide at most four updates per second per instrument, omit intervening prices, and different connections can see different samples. Messages are newline JSON over chunked transfer; heartbeats arrive every five seconds. These are delivery limits, not measured frequency or a tick-completeness guarantee. [Pricing](https://developer.oanda.com/rest-live-v20/pricing-ep/).

Published limits are 120 REST requests/second and 20 active streams per requesting IP, with at most two new connections/second. Prefer reused connections. [Development guide](https://developer.oanda.com/rest-live-v20/development-guide/), [connection guidance](https://developer.oanda.com/rest-live-v20/best-practices/).

UNVERIFIED: the configured account's streaming entitlement, XAU availability today, measured delivery rate, service terms, any account-specific fees, network latency and operational cost. No credentials were read and no provider or production request was issued. Public API support does not establish account entitlement or free service.

Decision: keep default-off REST polling for a bounded reference/shadow qualification stage. One instrument and one request in flight, proposed five-second polling and ten-second operation timeout, not an execution feed. OANDA's existing read-only adapter supports pricing and candles, but not a streaming parser/reconnect lifecycle. Streaming is a subsequent measured option if the approved research/entry horizon needs it. Before enabling streaming: verify read-only entitlement; implement strict practice-host allowlisting, bounded line/frame buffers, heartbeat watchdog, abortable connection, jittered capped reconnect backoff, generation fencing, gap markers and restart deduplication. A heartbeat updates connection health only, never quote freshness. Do not reconnect without bounds or erase outage intervals. Retain polling as an explicitly labelled fallback with no continuity claim.

## Honest state and quality

Every observation is practice dealer-indicative reference data, never an exchange execution quote or an executable price for an AURUM account. Provider and simulated quotes have literal `executable:false`. Missing data stays unavailable. No production account or balance is implied by a working feed.

TITANIUM fixes reject invalid/future event timestamps before the ordering watermark, reject fixture/mismatched provenance, require explicit tradeability for a quality pass, deep-copy returned state and recompute `status.currentQuality` at read time. `latest.quality` remains the verdict at receipt. Timeouts abort the transport and discard any late result. A fetcher that ignores abort retains the single-request slot until actual settlement, preventing abandoned-request accumulation. Such a stuck transport requires operator diagnosis/restart; it must not silently spawn more requests.

| Quality purpose | Recommended semantics | Activation |
| --- | --- | --- |
| REFERENCE_INGEST_QUALITY | Preserve bounded, parseable, honestly sourced observations with receipt verdict/reasons, including stale/wide/halted records for diagnostics; reject identity-invalid/future/one-sided events from canonical watermark | Off; D9-D11 |
| SHADOW_RESEARCH_QUALITY | Pre-register maximum age/spread/session and sampling policy; retain exclusions; require immutable dataset identity and no look-ahead | Blocked on dataset/trial accounting |
| PAPER_ENTRY_QUALITY | New assessment at admission and settlement; explicit tradeable=true, current session open, both clocks fresh, spread and expected net edge within approved budgets | Blocked C2/C3/C10 and thresholds |
| PAPER_EXIT_QUALITY | Independent reduce-only policy; entry spread caps cannot disable protection. Refuse missing/crossed/non-finite prices; explicitly define delayed/session/gap handling and conservative side | Protected execution work; no generic entry-gate reuse |

The existing 10 bps/5-second values are proposals, not approved operating limits. Recommended current configuration is `enabled:false` with entry and exit permissions absent. A five-second polling interval plus a five-second maximum age offers little latency margin and will create gaps; quantify that before selection. A single reference threshold cannot stand in for execution economics.

No authorised observed-price dataset was available in this review. Minimum, median, p75, p90, p95, p99 and maximum spread, session/volatility/news attribution are all UNVERIFIED, not zero. The earlier approximately 1.2 bps anecdote is not a distribution. Fixtures are excluded from empirical evidence.

Illustration only, midpoint $2,650 and explicit $1 point size: 10 bps equals $2.65 spread, costing GBP 1.325 / 2.65 / 13.25 at GBP 0.50 / 1 / 5 per point for an unchanged-price round trip, before slippage/funding. One bp is $0.265. Formula: `spreadPoints = ask-bid`; `bps = spreadPoints/mid*10000`; `GBP cost = spreadPoints/pointSize*stake`. No currency conversion is applied to a GBP-per-point contract. Ten bps can consume a short-horizon edge entirely; do not maximise quote eligibility to choose the limit.

D9/D10 recommendation: authorise a bounded reference-only measurement window and a resource budget first. Produce decimal-arithmetic, session-stratified percentiles, quote interarrival and end-to-end age distributions, outages and exclusion counts; volatility buckets use only prior available bars and event attribution requires an identified calendar. Then set separate research and entry caps from strategy net-edge/risk budgets. Numerical entry thresholds remain unset until evidence exists. Exit limits need their own protective design and approval.

## Durable shadow ingestion approval package

BLOCKED_APPROVAL: existing `MarketObservation` is DEX-shaped (required token/pool fields, one mid price, raw JSON, uniqueness by ingest run/pair) and is subject to unresolved research-identity retention dependencies. Reusing it would invent token metadata, grow the operational table, and fail to enforce durable event identity. Do not use `HistoricalBar` as a raw quote table or relabel sampled quotes as complete candles.

Requested protected scope: additive `GoldShadowQuote`, `GoldShadowIngestRun` and `GoldShadowSamplingBucket` models in `packages/shared/prisma/schema.prisma`, a new additive migration and DB constraint tests only; client regeneration by supported command. No existing model/risk/execution change, account creation, deployment or activation. Schema proposal:

- `GoldShadowQuote`: UUID primary key; provider/environment/instrument; full raw RFC3339 event timestamp text plus UTC event timestamp for range querying; receipt timestamp; canonical event SHA-256; raw payload hash; canonical decimal bid/ask/spread `Decimal(24,8)`; session; explicit nullable tradeability; verdict/reason codes; quality-policy hash; sampling-policy hash; run FK; `executionEligible=false` enforced by CHECK. Decimal representability validated before insert, never silently rounded. Unique `(provider, environment, instrument, eventIdentity)`; index `(instrument,eventTime,id)` and `(runId,receivedAt)`. Reject/capture same identity with conflicting payload in a bounded rejection audit, never overwrite it.
- Identity includes source, environment, instrument, original full-precision provider timestamp and canonical price/tradeability payload. Separate provider event key identifies conflicting revisions. Current parser truncates nanoseconds to milliseconds: preserve original time before using this design for streaming. Do not claim a millisecond quote ID is a tick identity.
- IngestRun: UUID, immutable config/policy hashes, transport mode, start/finish/heartbeat, bounded counters, error code, resume cursor and budget. Restart status is visible. It contains no provider token/account secret.
- SamplingBucket: unique `(provider,environment,instrument,policyHash,bucketStart)` with chosen event FK. Transactionally enforce one canonical observation per approved bucket across restarts/processes; source-event uniqueness alone cannot bound changed timestamps.
- Store a changed bid/ask/tradeability/session/verdict at most once per approved bucket; record unchanged responses as counters, not rows. Preserve first/last receipt and suppressed count in run/bucket audit. Sampling is explicit and disqualifies tick-complete claims. A singleton lease and DB uniqueness protect duplicate workers. Separate low bounded rejection/transition budget prevents outage floods.
- Proposed budget for approval: five-second buckets, no more than 17,280 accepted records/day or 518,400/30 days before closed sessions and deduplication; independent rejection cap, fixed batch/memory limits and storage high-water stop. Numbers are arithmetic ceilings, not measured throughput/storage. Size rows plus WAL/indices/backups on a disposable DB using `pg_total_relation_size`, `EXPLAIN (ANALYZE, BUFFERS)` range/restart queries and actual inserts before final budget approval. At stream maximum, unconstrained storage could be 345,600/day, which is not authorised.
- Raw quote retention and candle retention have separate policies. Research consumes content-addressed immutable exports with schema/provider/alignment/sampling/quality hashes, file checksums, read-back verification and a durable snapshot registry. Operational pruning cannot invalidate a registered snapshot. Until this is built and approved, no raw-quote deletion and no MarketObservation retention relaxation. Off-host archive destination/permissions/capacity require operator selection; same-disk files are not sufficient recovery proof.

Transaction tests required: duplicate/revised event, concurrent bucket insert, crash between quote and bucket/run update, restart cursor, future/out-of-order time, nanosecond collisions, precision bounds, policy change, budget stop, schema evolution and preserved snapshot hashes. Migration rollback must never drop populated evidence; disable ingestion and apply a forward fix.

No persistence code or scheduler was added because this schema boundary is expressly unapproved. Review package is ready for operator refinement and DB review, not for activation.

## Historical interface limits

The documented candle API supports bid/ask/mid components, up to 5,000 candles per request, explicit alignment and complete-bar flags; it does not reconstruct a complete quote sequence or a historical spread distribution from midpoint OHLC. [Candle parameters](https://developer.oanda.com/rest-live-v20/pricing-ep/), [interval definitions](https://developer.oanda.com/rest-live-v20/instrument-df/).

M1/M5/M15/H1/H4/D exist as API intervals, not verified local coverage. A bounded refresh must pin instrument/environment/components/alignment/schema, validate returned coverage and completeness, checkpoint only committed batches, deduplicate by interval/alignment/open time, hash exports and preserve gaps. Verify current endpoint compatibility before acquisition. No refresh, holdout access or campaign execution occurred in this review.
