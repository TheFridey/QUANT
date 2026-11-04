# GENESIS data coverage audit

Updated 3 Nov 2026. Written from the code on `main` (`9cb82a8`) and the docs in this repository, not from production. Production bar counts are quoted from [`docs/ascend/STATUS.md`](../ascend/STATUS.md) (ASCEND-01 row, 1 Nov 2026) and have not been re-checked here.

The ASCEND-01 warehouse (`HistoricalDataset`, `HistoricalBar`, raw batches, revisions, rejections, jobs, quotas) has exactly two bar sources: `GeckoTerminalPoolSource` and `AlpacaBarsSource` (`packages/market-data/src/history/sources.ts`). Every other provider in the repo serves current quotes only and cannot backfill history.

Status labels: `AVAILABLE` (a source is wired into the warehouse and has imported data), `AVAILABLE_NOT_IMPORTED` (a free source exists in the repo but is not a warehouse source yet), `NOT_AVAILABLE` (no source in the repo), `BLOCKED_APPROVAL` (needs a paid tier, licence or purchase that the operator must approve first). Nothing paid is enabled by this document.

## Summary

| Asset class | Provider in repo | Warehouse source? | History depth limit | Licence / tier | Survivorship | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Solana tokens (speculative DEX pools) | GeckoTerminal public API (`geckoterminal`) | Yes, `SOLANA_POOL` | About 180 days on the keyless tier; per-pool history starts at pool launch | Keyless; attribution "Data: GeckoTerminal" required; redistribution not assumed | Survivors only: the four pools are the ones the engine traded; no `INACTIVE` cohort yet | `AVAILABLE` (5m, 14-day windows) |
| Solana tokens, deeper than ~180 days | GeckoTerminal paid tier, or Birdeye `/defi/ohlcv` (`BIRDEYE_API_KEY`) | No | Plan-dependent | Paid API plan | Same | `BLOCKED_APPROVAL` |
| Established crypto on Solana (SOL/USDC, GATO) | GeckoTerminal (`geckoterminal`) | Yes, `SOLANA_POOL` | ~180 days (SOL/USDC 1h: 5 May → 1 Nov 2026, 4,337 bars); GATO since launch (25 Aug 2026) | As above | Liquid majors do not delist; the pool chosen is a present-day pool | `AVAILABLE` |
| Established crypto on centralised venues (BTC, ETH spot) | None | No | n/a | n/a | n/a | `NOT_AVAILABLE` |
| FX (EURUSD, GBPUSD, USDJPY) | `frankfurter_fx` (ECB daily reference rates, keyless), `oanda_practice` (practice account, unconfigured), `fx_stub` (DEMO) | No | Frankfurter: daily fixings back to 1999, but only `latest` is called and a fixing is not an OHLC bar. OANDA practice candles: not wired | Frankfurter free; OANDA needs a (free) practice account token, which is not configured | Majors do not delist | `AVAILABLE_NOT_IMPORTED` (Frankfurter daily close); intraday FX `NOT_AVAILABLE` |
| Indices (SPX, NDX, FTSE, DJI levels) | `index_stub` (null levels), `index_yahoo_delayed` (unofficial chart endpoint, today only) | No | None stored | Index levels are licensed by the index owners; the Yahoo endpoint has no usable licence for storage | n/a | `BLOCKED_APPROVAL` (licensed index data) |
| Equity ETFs (SPY, QQQ) | Alpaca market data v2, IEX feed (`alpaca_iex`) | Yes, `EQUITY_ETF` | Daily SPY 4 Jan 2021 → 30 Oct 2026, 1,464 bars. IEX history goes back further than imported | Free with the Alpaca account, own use only, no redistribution. IEX is one venue (partial volume). Consolidated SIP feed needs a paid plan | ETFs in scope do not delist; no corporate-action table, prices unadjusted (`adjustment=raw`) | `AVAILABLE` (IEX daily); SIP `BLOCKED_APPROVAL` |
| Commodities (XAUUSD, WTI paper proxies) | `commodity_stub` only | No | None | n/a. Commodity ETF proxies (e.g. GLD, USO) could come from Alpaca IEX free, not implemented | n/a | `NOT_AVAILABLE` |

## Per source notes

### GeckoTerminal (`packages/market-data/src/history/sources.ts`)
- Pool OHLCV by pool address, paged backwards with `before_timestamp`, `limit=1000`, `currency=usd`.
- `include_empty_intervals=false`: intervals with no trades are absent, not flat-filled. The quality report therefore classifies gaps in a sparse pool as `NO_TRADE_LIKELY`; in a series that is at least 95% complete a gap is `MISSING_DATA_SUSPECTED` instead, because a liquid pool very rarely has a no-trade hour.
- Rate: about 30 requests/min documented for keyless use; the source uses 10/min.
- Depth: the keyless tier returns roughly six months. Anything older needs the paid tier. **BLOCKED_APPROVAL** (purchase).

### Alpaca IEX (`AlpacaBarsSource`)
- Uses the paper account's data keys (`ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY`); without them the source returns `BLOCKED_EXTERNAL`.
- Daily bars open at 00:00 America/New_York (04:00Z or 05:00Z by DST); ASCEND-01 PR #34 fixed the original `MISALIGNED` rejections. The quality report checks daily coverage against the NYSE calendar and treats a missing session as `MISSING_DATA`.
- Intraday IEX bars come from a single venue and may have no prints in a minute; intraday gaps are classified like an omitting source.
- Consolidated (SIP) volume and prices need a paid Alpaca data plan. **BLOCKED_APPROVAL**.
- No corporate-action table: splits and dividends are recorded in unadjusted prices, not applied. SPY has had no split in the imported range; this matters for any single-stock work.

### Birdeye (`packages/market-data/src/birdeye.ts`)
- Optional; without `BIRDEYE_API_KEY` it returns `UNAVAILABLE`. Has an OHLCV endpoint but is not a warehouse source. Historical depth depends on the paid plan. **BLOCKED_APPROVAL**.

### DexScreener (`packages/market-data/src/dexscreener.ts`)
- Live snapshots only (no OHLCV history). Our own `MarketObservation` rows are the point-in-time record from the day collection started; they include pairs that later disappeared, so the observation-replay backtests are not survivors-only.

### FX
- `frankfurter_fx`: ECB reference rates, daily, free, no key. Could become a daily-close warehouse source (close-only bars, no OHLC, no volume); not implemented.
- `oanda_practice`: practice v20 adapter for quotes. Practice accounts are free but no token is configured, and candles are not wired. Not a paid item, but it needs an operator-held credential.
- Calendar used by the quality report: open Sunday 22:00 UTC to Friday 22:00 UTC. The engine's `FX_WEEKDAY` session in `packages/shared/src/sessions.ts` uses 17:00 New York, which is 21:00 UTC during US daylight time; the research calendar uses the fixed UTC boundary by design.

### Indices and commodities
- No historical source. Index levels from the index owners (S&P DJI, Nasdaq, FTSE Russell) require a licence. **BLOCKED_APPROVAL**.
- Commodity proxies are paper-only stubs.

## Survivorship bias

| Cohort (`HistoricalDataset.cohort`) | Contents today | Bias |
| --- | --- | --- |
| `LIQUID_MAJOR` | SOL/USDC pool | Negligible for the asset; pool choice is present-day |
| `ESTABLISHED_SOLANA` | GATO | Chosen because it survived to be traded |
| `SPECULATIVE_SOLANA` | Four pools the engine traded | Selected on survival and on having been traded |
| `BROAD_ETF` | SPY | None material |
| `INACTIVE` | Empty | The inactive / delisted cohort does not exist yet |
| `MAJOR_FX` | Empty | No FX history |

`survivorshipSummary` (in `packages/market-data/src/history/quality.ts`) reports `SURVIVORS_ONLY` while the `INACTIVE` cohort is empty. Every study over the warehouse must carry that label until inactive pools (rugged, abandoned or delisted tokens drawn from `MarketObservation` pairs that disappeared) are backfilled into an `INACTIVE` cohort. GeckoTerminal still serves OHLCV for dead pools, so this is achievable on the free tier within its ~180-day depth. Each dataset report also flags `POSSIBLY_INACTIVE` when its last bar is older than max(7 days, 24 bars).

## Tools

- Quality report: `node apps/worker/dist/src/history/quality-cli.js --list | --all | <datasetId> [--from ISO --to ISO] [--max-listed n]`; API `GET /api/research/data-quality` and `GET /api/research/data-quality/:datasetId` (JWT, read-only).
- Opportunity History: `node apps/worker/dist/src/history/opportunity-history-cli.js --from ISO --to ISO [--window-hours 6] [--account id] [--format jsonl|csv] [--out dir] [--counterfactual] [--horizons 1h,4h,24h]`.

## Not verified

- No production query was run for this document; counts are from STATUS.md.
- Provider depth limits are from the source comments and the providers' public documentation as recorded in the repo, not re-measured.
- The NYSE table (`NYSE_SPECIAL_DAYS`, 2021–2026) was written by hand from the published NYSE calendars; it agrees with the engine's table for 2025–2026 (unit test) and the 2025-01-09 national day of mourning is included, which the engine table lacks.
