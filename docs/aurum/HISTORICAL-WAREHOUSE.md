# AURUM historical gold warehouse

HELIOS, 18 November 2026. Facts are VERIFIED_PRODUCTION (observed on the practice API or the production warehouse in this operation), VERIFIED_REPOSITORY, or UNVERIFIED.

## 1. D17: OANDA practice history depth (VERIFIED_PRODUCTION)

**Approval:** operator approved D17 (18 Nov).
- The probe: [`evidence/d17-oanda-history-probe.cjs`](evidence/d17-oanda-history-probe.cjs). Output: [`evidence/d17-oanda-history-probe-20261118.json`](evidence/d17-oanda-history-probe-20261118.json).
- It made **9 read-only `GET /v3/instruments/XAU_USD/candles` requests** from the VPS (21:51 UTC).
- It used the existing adapter (`OandaPracticeMarketData`, practice-host allowlist) for M1–D. Only for S5, which the adapter does not list, it made one direct GET to the same practice host after asserting `OANDA_API_URL` is that host.
- No token or account id was printed and nothing was stored. No order-capable client exists in this path.

| Granularity | Earliest complete candle (`from=2000-01-01`, `count=1`) | Mid | Bid | Ask | First tick volume |
| --- | --- | --- | --- | --- | --- |
| S5 | 2006-03-18 20:49:55 UTC (a Saturday: early data quality is unproven) | yes | yes | yes | 1 |
| M1 | 2006-03-19 20:29 UTC | yes | yes | yes | 1 |
| M5 | 2006-03-19 20:25 UTC | yes | yes | yes | 1 |
| M15 | 2006-03-19 20:15 UTC | yes | yes | yes | 1 |
| M30 | 2006-03-19 20:00 UTC | yes | yes | yes | 1 |
| H1 | 2006-03-19 20:00 UTC | yes | yes | yes | 2 |
| H4 | 2006-03-19 20:00 UTC | yes | yes | yes | 5 |
| D (17:00 New York) | 2006-03-19 22:00 UTC | yes | yes | yes | 3,021 |

**Page limit:** an M1 request with `count=5000` from 2026-11-09 returned exactly 5,000 complete candles, with 0 missing bid or ask. Its 3 gaps were all daily breaks or the weekend, the largest 65 minutes.

**Limits:**
- "Earliest" means the first candle the practice API returns. It is not proof that early years are dense: first-candle tick volumes are 1–5.
- Completeness must be measured per year before research use.
- S5 data starting on a Saturday is unexplained.
- Licensing is as the repo's source descriptor states (account holder's own use, no redistribution); the terms were not re-read.

## 2. M1 pilot acquisition (VERIFIED_PRODUCTION)

- **Approval:** acquisition of up to 10 years (18 Nov).
- **Pilot:** one month, run with the deployed CLI:
  - `backfill-cli.js oanda_practice XAU_USD 1m PRECIOUS_METAL 2025-10-01T00:00:00Z 2025-11-01T00:00:00Z 20`;
  - **7 requests, 31,531 bars imported, 0 rejected, 0 revisions**; job `cmwmns29900022m317zugqdxi`.
- **Dataset:** a new identity, `cmwmns29200002m31xoax6coc` (`oanda_practice` / `XAU_USD` / `1m`, cohort `PRECIOUS_METAL`), `versionHash ce2ec434b811eec84272eae574217996`, covering 2025-10-01 00:00 to 2025-10-31 20:59 UTC. **No existing dataset was touched.**
- **Storage:**
  - database 15,468,326,235 → 15,487,036,763 bytes (+18.7 MB);
  - `HistoricalBar` +16.6 MB (about 528 B/bar); raw batches +2.0 MB (about 63 B/bar).
- **Completeness:** 0 bars missing bid or ask. All 22 gaps above 1 minute are 18 daily breaks (60–70 min) and 4 weekends; **0 unexplained intraday gaps**.
- **Spread at the M1 close** (`ask_c − bid_c`, USD points; October 2025 only; a bar-close sample, not a tick distribution):

  | min | median | P75 | P90 | P95 | P99 | max |
  | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
  | 0.18 | 0.74 | 0.91 | 1.08 | 1.24 | 1.64 | 5.00 |

  At about $4,000 gold, the median is about 1.8 bps, P99 about 4 bps and the maximum about 12.5 bps. The round-trip cost at the generic profile (£ per $1 point) is spread × stake: £0.37 (median) and £0.82 (P99) at the £0.50 minimum stake. This is one month of one regime; it is not a basis for thresholds by itself (D9/D10 stay open).

## 3. Ten-year M1 acquisition: estimate and blocker

| Item | Estimate (from the pilot) |
| --- | --- |
| Range | 2016-11 → 2026-11 (10 years), extending dataset `cmwmns29200002m31xoax6coc` (append-only; the version hash changes as it grows) |
| Bars | about 3.8 M (31.5 k per month × 120) |
| Requests | about 840 (the pilot averaged 4.5 k bars per request), in batches of at most 200 per invocation (5 invocations) |
| Database | about +2.2 GB |
| Backups | dumps compress to about 13% of the database, so about +0.3 GB per dump and about +4 GB across the 14-day window |
| Time | minutes per invocation. The CLI spaces requests and backs off on errors |

- **Blocked by the deployed storage quota:** `PrismaBackfillStore` refuses more than 200,000 bars per dataset, which is about 6 months of M1.
- **Fix on branch `aurum/helios-warehouse`:** bounded, opt-in flags `--max-bars-per-dataset=N` (at most 6 M) and `--max-total-bars=N` (at most 8 M).
  - Malformed or out-of-range values are refused rather than clamped. The default is unchanged. There are 4 tests.
- **To proceed:** merge, deploy the worker build (a deploy approval), then run:

  ```text
  node dist/src/history/backfill-cli.js oanda_practice XAU_USD 1m PRECIOUS_METAL 2016-11-01T00:00:00Z 2026-11-01T00:00:00Z 200 --max-bars-per-dataset=4000000 --max-total-bars=5000000
  ```

  Repeat until COMPLETED (5 invocations). The job resumes from its checkpoint.

## 4. Derived timeframes

- `packages/market-data/src/history/aggregate.ts` (CATALYST) aggregates canonical M1 into M5, M15, M30, H1, H4 and daily. It uses exact decimals and keeps bid/ask only when every member has it.
- Comparing derived bars with native bars needs both series for the same range. The native H1 (2024-11 → 2026-11) and the pilot M1 overlap in October 2025. That comparison is the next warehouse step and is not yet run.
