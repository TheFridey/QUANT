# PCR-2: multi-asset paper execution (protected change request)

Status: **proposal only. Nothing in this document has been applied.** Raised by OPERATION HORIZON on 5 Nov 2026 against `main` `b8cb0ce`. Every change below touches a protected path (AGENTS.md) or sits directly on the order path, so each needs the operator's protected-edit unlock, tests and an independent `quant-safety-reviewer` verdict before merge. Activation (wiring non-Solana instruments into live paper entries) is a separate operator decision after merge.

PAPER only throughout. No live money, no real-venue order submission, no signing or key handling, no change to `EXECUTION_MODE`, `LIVE_MONEY_*`, risk limits or `DEFAULT_STRATEGY`.

## Why

`docs/horizon/DIAGNOSIS.md` (branch `horizon/diagnosis`) found four independent blocking layers that keep QUANT on Solana: ingest, data shape, freshness label and fill economics. The `horizon/providers` branch removes what can be removed without the unlock: OANDA practice instruments/pricing/candles, Alpaca IEX quotes and bars, a descriptive `QuoteQuality`, warehouse sources, and pure FX-conversion and precision helpers in `packages/shared` (`fx-conversion.ts`, `precision.ts`, `quote-quality.ts`). The remaining layers are in protected code and are listed here.

## Interaction with PCR-1 (PR #45)

PCR-1 (`apex/pcr-1-lifecycle-fence`, draft, not applied) changes `packages/trading-engine/src/store.ts` and `strategy-allocations.ts` to fence pending exits with monotonic `cumBoughtQty` counters and stamps. PCR-2 items C2 and C3 also edit `store.ts`. Rules:

1. **PCR-1 lands first.** It fixes a live-path defect (a stale exit can sell a reopened lot). PCR-2 is a capability, not a fix.
2. PCR-2 is rebased onto PCR-1. Counters and stamps are quantities; C3 changes quantity rounding to lot steps, so the PCR-1 invariant `exit ≤ held − bought-since-booking` must be re-proved with lot-rounded quantities (test T-C3-4 below).
3. No PCR-2 change may alter PCR-1's lock scope or transaction boundaries.

## Changes, in rollout order

Each item: the exact change, rationale, risks, required tests. "Protected" names the guarded path.

### C1. Freshness admission for real-time non-crypto quotes by quality descriptor

- **Protected:** `packages/risk-engine/src/evaluate.ts` (`freshnessGate`, BUY valuation check); `packages/trading-engine/src/store.ts` (`gateAndQuote`, `resolveObservationFreshness`); the worker ingest that stamps `MarketObservation.freshness`.
- **Today:** Alpaca and OANDA quotes are stamped `DEMO`; `freshnessGate` rejects DEMO BUYs (`DATA_DEMO`) unless `allowDemoPaperEntries`, and `gateAndQuote` accepts DEMO BUYs only with `DATA_MODE=demo`, which ingests nothing. So no real non-crypto quote can open a paper position.
- **Change:** do **not** relabel provider quotes as LIVE. Instead persist the `QuoteQuality` descriptor with each observation and add an explicit admission rule: a non-crypto observation is admissible for a paper BUY only when **all** hold:
  - `quality.timeliness === "REAL_TIME"`, `quality.twoSided === true`, `quality.coverage` is `SINGLE_VENUE`, `CONSOLIDATED` or `DEALER_INDICATIVE` (never `REFERENCE_RATE`, never `RECORDED`/`UNKNOWN`);
  - `quality.quoteAgeMs ≤ liveMaxAgeMs` measured from the provider event time, and the observation `receivedAt` is also within `liveMaxAgeMs`;
  - `quality.providerTradeable !== false` (OANDA) and the instrument session is OPEN;
  - the instrument is enabled for paper by an operator-controlled flag (default off).
  The resulting freshness passed to risk is a new explicit value derived by a single pure function (`admissionFreshness(observation)`), so DEMO and DELAYED semantics are unchanged for every existing caller. Frankfurter stays DELAYED and can never open risk.
- **Rationale:** the descriptor already says, honestly, what each quote is. Admission should rest on that, not on a blanket relabel.
- **Risks:** IEX is ~2-3% of US volume, so IEX mid can differ from the NBBO; OANDA practice prices are dealer-indicative. Mitigation: per-instrument spread cap (C6) and conservative fills (C3). Any bug here opens risk on bad data, hence default-off flag and C1 shipping alone first.
- **Tests:** table test of `admissionFreshness` over every feed/coverage/timeliness/age/tradeable/session combination; Frankfurter, fixture and one-sided quotes always rejected; boundary at exactly `liveMaxAgeMs` and +1 ms; future-dated event time rejected; a regression test that every pre-existing `evaluateRisk` and `gateAndQuote` case returns the same decision; property test "no input with `coverage = REFERENCE_RATE` ever yields LIVE".

### C2. Fill currency conversion (quote → USD)

- **Protected:** `packages/trading-engine/src/fill.ts` (`quoteFill`), `store.ts` (settlement and ledger writes), `ledger.ts`.
- **Today:** `priceUsd` is the raw quote-currency level. USD/JPY would book ~150 JPY as $150 (DIAGNOSIS layer 4). `convertToUsd` in `money.ts` has no production caller.
- **Change:** carry `quoteCurrency` and the quote-currency price on the order; at fill time convert notional, fee and P&L with `convertAmountToUsd` / `pairPnlUsd` (`packages/shared/src/fx-conversion.ts`) using the current conversion rate from a fresh observation, refusing with `FX_RATE_UNAVAILABLE` when the rate is missing, stale or has no direct USD leg. Store the rate, its source and its age on the fill for audit. Valuation of open non-USD positions uses the same rule; a missing rate leaves the mark missing (never zero P&L).
- **Risks:** a stale rate at the weekend blocks valuation of JPY positions; that is intended (fail closed) but it raises `MARK_UNAVAILABLE`, which blocks all new entries account-wide. Mitigation: no JPY-quoted entries without an operator decision on weekend handling.
- **Tests:** USD/JPY round trip books P&L in USD at the exit-time USDJPY rate (golden values from `fx-conversion.test.ts`); stale/missing/future rate → `FX_RATE_UNAVAILABLE` with no ledger write; EUR/USD unchanged to the last decimal; ledger identity (cash + positions = equity) holds after a JPY round trip; replay determinism.

### C3. Fill precision and contract multiplier

- **Protected:** `fill.ts`, `store.ts`, `size.ts`.
- **Today:** prices and quantities round to 8 dp; registry `tickSize`/`lotSize` and `ProductSemantics.multiplier` are ignored.
- **Change:** round fill prices with `roundPriceToTick` (BUY fills `UP`, SELL fills `DOWN`, i.e. never in the trader's favour), quantities with `roundQtyToLot` (always down), refuse below one lot (`BELOW_MINIMUM_QTY`), and compute notional as `qty × price × multiplier` (`notionalInQuote`). Multipliers stay 1 for every current registry instrument.
- **Risks:** rounding down quantities can leave a dust remainder on exits; the exit path must sell the full held quantity even when it is not a lot multiple (risk-reducing). Interaction with PCR-1 counters.
- **Tests:** T-C3-1 tick rounding direction per side; T-C3-2 lot rounding never enlarges a BUY; T-C3-3 a full exit of a non-lot holding closes it; T-C3-4 PCR-1 fence invariant holds with lot-rounded quantities (property test); T-C3-5 Solana fills byte-identical to today (8 dp path untouched for `SPOT_CRYPTO_PAIR`).

### C4. Planner `quoteFill` instrumentId mismatch

- **Path:** `packages/agent-core/src/plan.ts:924` (not on the protected list, but on the order path; ship with C3 and review together).
- **Today:** the planner calls `quoteFill` without `instrumentId`, so it prices every order with the Solana DEX cost model (impact against `liquidityUsd`), while settlement (`store.ts` `gateAndQuote`) passes the instrument key and uses the FX/ETF/commodity model. A non-crypto order with null liquidity is rejected `MISSING_LIQUIDITY` at planning even though settlement would accept it; if it were planned, the planned and settled costs would differ.
- **Change:** pass `instrumentId` (registry id when `pair.pairAddress` contains `:`) to the planner's `quoteFill`, matching `admit.ts`.
- **Tests:** planner and settlement produce the same `FillQuote` for the same inputs, per asset class; Solana planning unchanged.

### C5. Settle DEMO gate

- **Protected:** `packages/trading-engine/src/store.ts` (`gateAndQuote`, lines ~72-81 at `b8cb0ce`).
- **Today:** DEMO BUYs fill only with `allowDemoPaperEntries` **and** `DATA_MODE=demo`; risk admits DEMO BUYs with the flag alone. The two gates disagree, so an admitted DEMO entry can never fill and sits pending until expiry.
- **Change:** make settlement use the same `admissionFreshness` function as C1, so admission and settlement cannot disagree. Do **not** loosen the DEMO rule itself: DEMO stays non-fillable outside `DATA_MODE=demo`.
- **Tests:** for every freshness value and flag combination, `evaluateRisk` PASS ⇒ `gateAndQuote` does not reject on freshness, and REJECT ⇒ no fill; existing DEMO/DELAYED exit behaviour unchanged.

### C6. Per-instrument cost model

- **Protected:** `packages/trading-engine/src/cost-model.ts`.
- **Today:** fixed estimates (FX 1.5 bps spread, ETF 2 bps, commodity 5 bps) regardless of the observed spread.
- **Change:** use `max(configured estimate, observed half-spread from the quote's bid/ask)` for fills, and reject entries whose observed spread exceeds a per-asset-class cap (new config, conservative defaults, not a relaxation of any existing limit). Record the spread used on the fill.
- **Tests:** observed spread wider than the estimate raises cost; missing bid/ask falls back to the estimate and is flagged; spread above cap rejects BUYs but never blocks a risk-reducing SELL.

### C7. OANDA practice venue (optional, last)

- **Protected:** new `packages/market-data/src/oanda-practice-venue.ts` (venue file), `execution-gateway.ts`, `broker-reconcile.ts`.
- **Change:** a practice-only venue mirroring `alpaca-practice-venue.ts`: strict host `api-fxpractice.oanda.com`, refuses `api-fxtrade.oanda.com`, sandbox execution mode only, reconcile against practice account state. Not needed for internal paper fills (C1-C6); only for practice-broker parity.
- **Risks:** any credential-bearing order path is high risk. The existing `OandaPracticeProvider.submitProtectiveOrders` POSTs against `OANDA_PRACTICE_HOSTS`, which still admits loopback http; C7 should move it to the strict allowlist.
- **Tests:** host allowlist (live host, userinfo, path tricks rejected); no order call without `EXECUTION_MODE=PAPER` and the practice host; reconcile never invents fills.

## Rollout

1. PCR-1 merged and soaked.
2. C4 + C5 (no behaviour change for Solana; removes the admission/settlement disagreement). Safety review.
3. C1 behind a default-off per-instrument flag. Safety review. Merge with the flag off.
4. C2 + C3 + C6 together (fill economics). Safety review. Replay/backtest parity for Solana must be byte-identical.
5. Operator enables ingest of OANDA/Alpaca quotes into `MarketObservation` for one instrument (EUR/USD), shadow only: entries still off. Observe a week with the market probe (`apps/worker/src/history/market-probe-cli.ts`).
6. Operator enables paper entries for EUR/USD only. Then SPY/QQQ. USD/JPY only after the weekend valuation decision (C2 risk). XAU/USD only once an OANDA account shows it available.
7. C7 only if practice-broker parity is wanted.

Each step is reversible by turning its flag off; no step changes risk limits or live-money gates.

## External blockers

- No OANDA credentials (DIAGNOSIS). A free fxTrade Practice account must be opened by the operator; XAU_USD availability depends on the account's region and must be confirmed with `availability()` before any gold work.
- Alpaca free plan: IEX only (single venue). SIP real-time needs a paid plan, which is out of scope.
