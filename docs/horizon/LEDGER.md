# HORIZON ledger

Operation HORIZON (multi-asset expansion). Evidence labels as in [`docs/genesis/EXECUTION_LEDGER.md`](../genesis/EXECUTION_LEDGER.md). Diagnosis: [`DIAGNOSIS.md`](DIAGNOSIS.md). Nothing here enables new trading.

## Checkpoint 2: 6 Nov 2026, ~10:10 UTC (`5fe4484` deployed)

Operator: "Merge and deploy". Merged #60 (`999a6ea`), #62 (`0a5559a`), #61 (`aa46037`), #63 (`5fe4484`); no conflicts; main CI green on `5fe4484`.

Deploy: fast-forward `5e26943` → `5fe4484`; no migration; lockfile unchanged; no protected paths; backup `quant-20261106T100335Z.dump` (703 MB, 67 tables); snapshot `/srv/quant/releases/5e26943-20261106T100447Z`; `quant-api`, `quant-worker`, `quant-web` restarted 10:07:18 UTC. Smoke: health `ok`; 144 observations in 2 min; cycles advancing; 0 API/worker error lines; web 307; `/api/research/opportunities` 401 without a token (guarded); other tenants 200. Not verified: scanner UI in a logged-in browser.

Risk config at deploy (not changed by this deploy): `maxDailyLossPct` 10, `maxTotalDrawdownPct` 30, set by the operator through the Settings panel (revision 2, `operator@quant.local`, 4 Nov 22:47 UTC). Equity 9,035.94 vs HWM 10,106.00 (10.6% drawdown, under the 30% limit); 50 orders since 4 Nov 22:44 UTC.

Market probe on production (read-only, `5fe4484`, ~10:09 UTC Friday):

| Instrument | Result |
| --- | --- |
| Solana universe | not probed (worker discovery) |
| EUR/USD, GBP/USD, USD/JPY | Frankfurter ECB reference rate only (`REFERENCE/REFERENCE_RATE`), not tradeable; USD/JPY also needs quote→USD conversion (PCR-2) |
| SPY | Alpaca IEX **real** quote received, `REAL_TIME/SINGLE_VENUE`; outside RTH (bid 712.54 / ask 758.52, stale overnight IEX book) — `SESSION_CLOSED: OUTSIDE_RTH` |
| QQQ | Alpaca IEX quote, one-sided outside RTH (`ONE_SIDED_QUOTE`, `SESSION_CLOSED`) |
| XAU/USD, WTI | `PROVIDER_NOT_CONFIGURED: oanda_practice MISSING_CREDENTIALS` |
| SPX, NDX, FTSE, DJI | research only, no provider |
| All non-Solana | `NOT_WIRED_INTO_PAPER_PIPELINE` (activation needs operator approval and PCR-2) |

So the Alpaca data path is `VERIFIED` against the real API; OANDA is still unverified (no account).

## Checkpoint 1: 6 Nov 2026

| PR | Scope | State |
| --- | --- | --- |
| [#60](https://github.com/TheFridey/QUANT/pull/60) | Diagnosis and this ledger | docs |
| [#61](https://github.com/TheFridey/QUANT/pull/61) | Per-market research configs (crypto, gold, FX, ETF), `FX_24_5` calendar, six cost-gated strategy families, `horizon-cli` | CI green; research only |
| [#62](https://github.com/TheFridey/QUANT/pull/62) | OANDA practice adapter (instrument availability, bid/ask pricing, candles, precision), Alpaca IEX quotes and intraday bars, warehouse sources, additive quote-quality descriptor, FX conversion and tick/lot helpers (unwired), read-only market probe, PCR-2 | CI green; quant-safety-reviewer APPROVE WITH NOTES (notes 1–3 fixed) |
| [#63](https://github.com/TheFridey/QUANT/pull/63) | Opportunity scanner: readiness ladder, evidence-only ranking with abstention, P&L by market, read-only API, Market Scanner/Selector UI | CI green (incl. e2e) |

No protected path changed, no freshness label changed, no new instrument wired into live paper entries, no migration, no risk limit changed.

### Real-data runs (`HISTORICAL_VERIFIED` as runs; no edge)

`horizon-cli` at `5902f49` on the read-only warehouse export (4 Nov 2026), seed 1, prior trials 2,474, holdout never consumed.

| Dataset | Strategy families (walk-forward, P90 cost, proxy flag) | ML 2.0 | Overall |
| --- | --- | --- | --- |
| SPY 1d | all INSUFFICIENT_EVIDENCE (6–21 OOS trades < 30) | NO_SKILL (AUC 0.502, lower 0.453) | NO_SKILL |
| SOL/USDC 1h | INSUFFICIENT_EVIDENCE; vol-expansion OOS net return not positive | NO_SKILL (AUC 0.460, lower 0.374) | NO_SKILL |
| GATO 1h | INSUFFICIENT_EVIDENCE; MTF trend REJECTED_RISK (OOS max drawdown 85.9%) | INSUFFICIENT_EVIDENCE (≈35 independent labels) | NO_SKILL |

Runs took 1.6–7.3 s and ≤ 195 MB RSS. No gold or FX data exists to test.

### Answers to HORIZON's five questions (today)

1. **Observable:** Solana pools only (DexScreener). With credentials and a deploy of #62: SPY/QQQ via Alpaca IEX (single venue, real-time); gold/FX via OANDA practice if the account offers them.
2. **Paper-tradable safely:** Solana pools only. Non-crypto needs PCR-2 (protected) after PCR-1.
3. **Positive after costs:** none found on any tested market.
4. **Why one market over another:** the scanner (#63) shows the readiness ladder and abstention reasons per market; today every non-Solana market stops before OBSERVABLE.
5. **Supporting results:** the runs above and the GENESIS ML runs; no prospective (shadow) results yet.

## Blockers

| Blocker | Type | Unblocks |
| --- | --- | --- |
| Gold and intraday FX data | `BLOCKED_EXTERNAL` | Operator opens a free OANDA fxTrade Practice account and sets `OANDA_API_TOKEN`, `OANDA_ACCOUNT_ID`; then run the market probe to confirm XAU_USD |
| Consolidated US quotes | `BLOCKED_APPROVAL` (purchase) | Alpaca SIP plan; IEX-only meanwhile |
| Non-crypto paper execution | `BLOCKED_APPROVAL` (protected paths) | PCR-1 then PCR-2 via operator unlock and safety review |
| Ingesting non-Solana markets into the live pipeline | `BLOCKED_APPROVAL` | Operator decision after PCR-2 |
| Deploy of #61–#63 | `BLOCKED_APPROVAL` | Operator go-ahead (no migration; read-only additions) |
