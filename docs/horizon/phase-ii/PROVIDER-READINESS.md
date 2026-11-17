# HORIZON Phase II: provider and per-market readiness (17 Nov 2026)

Read-only evidence from the VPS (`PROD`):

- `apps/worker/dist/src/history/market-probe-cli.js`, run twice. The first run, at about 10:20 UTC, failed every OANDA call with `fetch failed`; the second, at 10:25:45 UTC, succeeded.
- A one-off availability and pricing read for the extra instruments, at about 10:27 UTC on a Tuesday.

No order call was made, and no credential value was printed.

## Providers

| Provider | Configured | Operational | Data | Notes |
| --- | --- | --- | --- | --- |
| OANDA fxTrade Practice | yes (`OANDA_API_TOKEN`, `OANDA_ACCOUNT_ID`, `OANDA_API_URL` = practice host) | yes, with transient failures (1 of 2 probes) | dealer-indicative bid/ask, real time, provider `time` and `tradeable` | Not a venue. No retry, 429 handling only in the read-only client (`oanda-practice.ts:631`) |
| Alpaca (IEX feed) | yes (`ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`) | yes | IEX single-venue quotes; overnight book stale and wide | SIP needs a paid plan (`BLOCKED_APPROVAL`, purchase) |
| Frankfurter (ECB) | public | yes | daily reference rate | **Never** an execution quote (`assessQuoteAdmission` refuses `REFERENCE_RATE`) |
| DexScreener | public | yes | Solana pools | unchanged |

## Instrument availability (OANDA account, `/v3/accounts/{id}/instruments`)

All requested names are available and `tradeable: true` at 10:27 UTC. Spreads are computed from that read.

| Market | OANDA name | Product | Bid / ask (10:27 UTC) | Spread | In registry |
| --- | --- | --- | --- | --- | --- |
| Gold | XAU_USD | spot CFD, multiplier 1 | 3855.160 / 3855.550 | ≈1.0 bps | `commodity:XAUUSD` |
| Silver | XAG_USD | spot CFD | 47.317 / 47.340 | ≈4.9 bps | **no** |
| EUR/USD | EUR_USD | spot FX | 1.09911 / 1.09919 | 0.73 bps | `fx:EURUSD` |
| GBP/USD | GBP_USD | spot FX | 1.31911 / 1.31921 | 0.76 bps | `fx:GBPUSD` |
| USD/JPY | USD_JPY | spot FX, JPY quote | 159.049 / 159.064 | 0.94 bps | `fx:USDJPY` (off by default) |
| AUD/USD | AUD_USD | spot FX | 0.67338 / 0.67352 | 2.1 bps | **no** |
| USD/CAD | USD_CAD | spot FX, CAD quote | 1.42977 / 1.42994 | 1.2 bps | **no** |
| WTI | WTICO_USD | **CFD on WTI, not a CL futures contract** | 85.930 / 85.960 | 3.5 bps | `commodity:WTI` |
| Brent | BCO_USD | **CFD on Brent, not ICE futures** | 93.926 / 93.966 | 4.3 bps | **no** |
| S&P 500 | SPX500_USD | **index CFD**: neither the SPX level nor SPY | 7398.6 / 7399.1 | 0.7 bps | **no**; must not be `index:SPX` |
| Nasdaq 100 | NAS100_USD | index CFD | 27133.4 / 27136.4 | 1.1 bps | **no** |
| Dow 30 | US30_USD | index CFD | 51391.9 / 51396.4 | 0.9 bps | **no** |
| Russell 2000 | US2000_USD | index CFD | 2730.525 / 2731.025 | 1.8 bps | **no** |

## Equity ETFs (Alpaca IEX latest quote at 10:27 UTC = 05:27 ET, pre-market)

| ETF | Bid / ask | Quote time | State |
| --- | --- | --- | --- |
| SPY | 719.70 / 764.77 | 16 Nov 21:00 UTC | stale overnight book, 607 bps wide. `SESSION_CLOSED: OUTSIDE_RTH` |
| QQQ | 661.83 / 661.91 | 16 Nov 21:41 UTC | stale, 13 h old |
| DIA | 502.06 / — | 16 Nov 21:00 UTC | one-sided |
| IWM | 265.13 / — | 16 Nov 21:00 UTC | one-sided |

An RTH read is still to do (`UNVERIFIED` today). Outside RTH every ETF must be refused, and `assessQuoteAdmission` does refuse these on age, session and spread.

## Per-market readiness (maturity ladder, `packages/analytics/src/maturity-ladder.ts`)

| Market | Stage | First blocker | Next action |
| --- | --- | --- | --- |
| Solana pools | PAPER (existing path) | account drawdown latch (B15) | operator decision |
| EUR/USD, GBP/USD | OBSERVABLE (DATA_VALID would need ingest) | `NOT_INGESTED`, then `NO_VALIDATED_RESEARCH` | shadow ingest (R2); intraday campaign |
| USD/JPY | OBSERVABLE | as above, plus A5 (JPY→USD) | after EUR/USD |
| AUD/USD, USD/CAD | REGISTERED: not in the registry | registry entry (research-only) | add with `enabledByDefault: false` |
| XAU/USD | OBSERVABLE | ingest; CFD session now modelled | shadow ingest; campaign |
| XAG/USD | not registered | registry entry | research-only |
| WTI | OBSERVABLE | ingest; must stay labelled CFD | research-only first |
| Brent | not registered | registry entry | research-only |
| SPY, QQQ | OBSERVABLE (IEX) | RTH-only, IEX spread cap, ingest | shadow ingest in RTH |
| DIA, IWM | not registered | registry entry | research-only |
| SPX, NDX, DJI, FTSE (index levels) | REGISTERED, research only | no provider of real index levels | stays research-only. OANDA CFDs are a different product |

## Data handling rules (in code or to be enforced)

| Rule | Where |
| --- | --- |
| Provider event time and receive time are both checked; future-dated quotes are refused | `assessQuoteAdmission` (done) |
| One-sided, crossed and locked books are refused | done |
| Session, weekend, holiday, early close and DST, in America/New_York | `sessions.ts` (done for US equity, FX and metals/energy CFDs; FTSE open) |
| Per-instrument breaker, backoff, Retry-After | `provider-circuit.ts` (done, not wired) |
| Explicit provider failure states | `ProviderFailureKind`; the OANDA/Alpaca clients already return `AUTH_FAILED`, `RATE_LIMITED` and `HTTP_ERROR` |
| Rate budgets: Alpaca free plan 200 req/min, bars spaced at 30 req/min (`alpaca-paper.ts:515-526`); OANDA batches up to 20 names per pricing call | one OANDA pricing call and one Alpaca call per cycle for every instrument |
| DEMO or delayed data never relabelled LIVE | unchanged; admission is a separate descriptor |
