# HORIZON ledger

Operation HORIZON (multi-asset expansion). Evidence labels as in [`docs/genesis/EXECUTION_LEDGER.md`](../genesis/EXECUTION_LEDGER.md). Diagnosis: [`DIAGNOSIS.md`](DIAGNOSIS.md). Nothing here enables new trading.

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
