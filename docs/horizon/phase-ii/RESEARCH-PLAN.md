# HORIZON Phase II: research plan (gold, FX, equity proxies)

Research only. Nothing here promotes, registers for shadow or trades. Campaigns use the existing durable architecture: `packages/evolution/src/campaign/*`, `campaign-cli`, ledger-reserved trials and `dsr-2.0.0`. No new trial framework is proposed.

## 1. Why earlier studies failed

Results are recorded in `docs/horizon/LEDGER.md`, checkpoints 1, 3 and 4.

| Outcome | Where | Cause (from the recorded numbers) | Implication |
| --- | --- | --- | --- |
| INSUFFICIENT_EVIDENCE | all daily families (6–26 OOS trades < 30); SPY 1d | slow families on 10 years of one instrument produce too few independent trades | add instruments to a family (pooled cohort), or use faster bars. Do **not** lower the 30-trade bar |
| REJECTED_OVERFIT | most hourly FX/XAU families (PBO 0.58–0.98, DSR ≈ 0) | parameter grids larger than the signal supports, with the full programme N deflating DSR | smaller pre-registered grids; one family per hypothesis |
| REJECTED_COSTS | EUR/USD MTF trend (gross +1.53% → net −0.05%), GBP/USD ATR breakout (+1.01% → −0.25%) | edge smaller than retail spread plus fee | only hypotheses with an expected move ≥ k·cost (cost gate k = 2 already in `market-config.ts`) |
| NO_SKILL (ML 2.0) | every market (AUC 0.47–0.53, lower bound < 0.5) | no predictive signal in the default feature set | a valid result; record it, do not retune |

**Not to be done:**

- rerun with tweaked grids until something passes;
- drop the costs;
- consume holdouts outside an authorised campaign.

Each new campaign is a new pre-registered spec. Its trials count against the programme N whatever the outcome (`accounting.ts:59-106`).

## 2. Proposed campaigns (bounded, pre-registered)

| ID | Markets | Bars | Families (existing code) | Max trials | Holdout |
| --- | --- | --- | --- | --- | --- |
| HZ2-FX-SESSION | EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD (pooled) | 15m | `hz_session_breakout` (London/NY open), `hz_vol_expansion` | 240 | last 6 months, withheld unless authorised |
| HZ2-METALS | XAU/USD, XAG/USD (pooled) | 1h | `hz_atr_breakout`, `hz_mtf_trend`, `hz_regime_breakout` | 180 | last 6 months |
| HZ2-ETF-ORB | SPY, QQQ, DIA, IWM (pooled) | 5m, RTH only | **opening-range breakout: new family, not yet written** | 120 | last 6 months |
| HZ2-ENERGY | WTI, Brent CFDs | 1h | `hz_atr_breakout`, `hz_vol_mean_reversion` | 120 | last 6 months |

Every campaign uses:

- the P90 cost model with session widening (`market-config.ts:268`);
- walk-forward;
- PBO and `dsr-2.0.0` with the full programme N;
- a 30 OOS-trade minimum;
- a seed fixed in the spec;
- the dataset pinned by `asOf` + `versionHash`.

Total pre-registered: 660 trials. Expected outcome: the same as before (no candidate) unless pooling and session timing reveal something. That is acceptable.

**Features by market.** Realised and relative volatility, ATR-normalised moves, session position, trend regime and spread-adjusted opportunity (expected move minus observed cost). These exist in `features.ts` and `market-config.ts`, except spread-adjusted opportunity, which needs the spread history from B3. For FX, metals and energy the feature sets must be volume-less. Tick counts are allowed only where OANDA reports them as tick volume, labelled as such. **No DEX liquidity, transaction counts or traded volume is fabricated.**

## 3. Strategy assumptions inherited from Solana

| Assumption | Where | Replacement |
| --- | --- | --- |
| One global `entryM5ChangePct = 2` | `strategy.ts:13,303`; `pulse.ts:291-309`; `strategy-library.ts` | per-instance params from a validated campaign, as ATR multiples. Paper activation needs operator approval; `DEFAULT_STRATEGY` stays unchanged |
| SENTINEL liquidity and volume floors apply to every instrument | `sentinel.ts:32-34` | an asset-class rule: non-crypto is judged on quote quality (`assessQuoteAdmission`), spread and session, never on DEX liquidity |
| txn imbalance, relative volume, volume acceleration | `pulse.ts` | crypto only |
| 24/7 calendar in shadow | `bridge.ts:38-43`, `genesis/shadow.ts:204` | session calendars and volume-less feature sets (HANDOVER next-work 1) |

## 4. Data sufficiency and refresh

| Need | Available (PROD) | Gap | Command (operator, read-only to the provider) |
| --- | --- | --- | --- |
| FX 15m, 2 years, 5 pairs | 1h for 3 pairs only, ending 6 Nov | 15m backfill, plus AUD and CAD | `backfill-cli --source oanda_practice --granularity M15 --from 2024-11-01` per pair |
| Metals 1h | XAU to 6 Nov | XAG; refresh XAU | same, H1 |
| ETF 5m RTH, 2 years | SPY 1d only | 5m bars for 4 ETFs (Alpaca IEX, 30 req/min) | `backfill-cli --source alpaca_iex --interval 5m` |
| Energy 1h | none | WTI and Brent CFDs | OANDA H1 |

Volume: about 50k bars per FX pair at 15m and about 39k per ETF at 5m RTH. That is roughly 0.5 M `HistoricalBar` rows, about 250 MB at the current row size (`INFERRED`).

## 5. Legacy pre-ledger trial declaration (F03-H)

Still blocked on operator input.

- Production has 2,454 `ResearchTrial` rows from 174 runs, all on 1 Nov.
- `ResearchTrialLedger` has 0 rows.
- Checkpoint 9 reported a programme count of 2,170 from `campaign-cli trials`. The difference (284) is **not reconciled** in this session.
- The unrecorded CSV-era trials are estimated at about 550–830 (`docs/integrity/F03-F06-RESEARCH-INTEGRITY.md`).

**Rule: no Phase II campaign runs before the questionnaire is answered and `declare-legacy-trials` is run**, because every DSR would otherwise be optimistic.

## 6. Safe operating plan for continuous research

| Control | Setting |
| --- | --- |
| Enable | `RESEARCH_CAMPAIGN_WORKER_ENABLED=true` only after the operator applies the systemd isolation recipe (F10-OS) |
| Compute | 1 unit at a time (`--units 1`), tick 60 s, `nice`; ≤ 1 h per unit (spec ceiling) |
| Memory | heap and RSS limits per unit ≤ 1.5 GB (recorded runs peaked at 357 MB); a cgroup is required (`RESEARCH_CAMPAIGN_REQUIRE_OS_ISOLATION=true`) |
| Trial budget | the pre-registered `maxTrials` per campaign above; reserved before run |
| API budget | backfill only, run by hand, never from the worker; probes ≤ 8 requests |
| Cancellation | `campaign-cli cancel`; shutdown aborts the tick (L5) |
| Recovery | leases expire; `ABANDONED` units retry ≤ 5 attempts |
| Dataset refresh | a new `asOf` means a new campaign version; results never mix datasets |
| Shadow | `GENESIS_SHADOW_ENABLED` stays off until the shadow service supports session calendars |
| Operator controls | disable flag, cancel, holdout authorisation (≤ 7 days) |
