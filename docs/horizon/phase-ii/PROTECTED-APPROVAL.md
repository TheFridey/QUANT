# HORIZON Phase II: protected-path approval request

**Status: REQUEST. Nothing here has been applied.** The agent stops here. Each line item needs:

1. the operator's explicit approval in chat, naming the item;
2. the operator-created `.claude/protected-edits.unlock` (the hook still asks per edit);
3. tests as listed;
4. an independent `quant-safety-reviewer` verdict before it is reported done.

Approval of one item does not approve another. No item changes `EXECUTION_MODE`, `LIVE_MONEY_*`, `execution-gate.ts`, `DEFAULT_STRATEGY` values or any risk limit. No item submits orders to a real or practice venue.

Every item ships **inert**: behaviour is unchanged until a per-instrument flag is on. The flag is `paperEntryInstruments: string[]` in engine config. It defaults to `[]`, and adding it is a schema addition, not a limit change. Solana is excluded from all of these paths by asset class.

## A1. Risk admission for qualified non-crypto quotes (C1)

- **Files:**
  - `packages/risk-engine/src/evaluate.ts`: `freshnessGate` (206-219) and the BUY valuation check (80-83).
  - A new input field `quoteAdmission?: QuoteAdmission` on the risk input.
- **Existing behaviour:** DEMO BUY is refused (`DATA_DEMO`) unless `allowDemoPaperEntries`. DELAYED BUY is always refused.
- **Proposed behaviour:**
  - For an instrument whose id starts `fx:`, `etf:` or `commodity:`, is listed in `paperEntryInstruments`, and carries `quoteAdmission.admissible === true` (from `assessQuoteAdmission`), the BUY passes the freshness rung.
  - In every other case the existing rules apply unchanged.
  - The observation keeps its stored `dataState`; nothing is relabelled.
- **Invariants:**
  - No `REFERENCE_RATE`, DELAYED, RECORDED, one-sided, crossed, stale, future-dated or closed-session quote ever passes.
  - SELL and exit semantics are unchanged.
  - Solana is unchanged.
  - The decision is a pure function of persisted data, so it is replayable.
- **Tests:**
  - table over every `dataState` × flag × admission result;
  - "every pre-existing `evaluateRisk` fixture gives the identical decision" (golden);
  - property: no `REFERENCE_RATE` input ever passes;
  - an instrument not in the list is refused even with an admissible quote.
- **Failure scenarios:**
  - A bad descriptor opens risk on bad data. Mitigations: fail-closed classifier, default-off list, spread cap.
  - Clock skew. Mitigation: tolerance capped at 1 s.
- **Rollback:** empty the list (instant). Code revert has no schema impact.

## A2. Settlement uses the same admission (C5)

- **Files:**
  - `packages/trading-engine/src/store.ts`: `gateAndQuote` (98-139) and `resolveObservationFreshness` (918-933).
- **Existing behaviour:** DEMO BUY fills only with the flag **and** `DATA_MODE=demo`, which disagrees with risk.
- **Proposed behaviour:**
  - The non-crypto BUY path calls `assessQuoteAdmission` on the **fill** observation, with the same config.
  - Admission at risk and admission at fill are evaluated independently. Both must pass.
  - The DEMO rule outside demo mode is unchanged.
- **Invariants:**
  - risk PASS ⇒ settle does not refuse on freshness for the same observation;
  - settle never fills on an observation risk would refuse;
  - the lock and transaction boundaries are unchanged;
  - no network I/O is added inside the transaction.
- **Tests:**
  - agreement property over all combinations;
  - DEMO/DELAYED exits unchanged;
  - `store.exit-policy.integration.test.ts` and `lifecycle-fence` suites pass unchanged.

## A3. Pending-fill eligibility documentation and tests (C8)

- **File:** `packages/trading-engine/src/eligible-observation.ts` (61-82). Tests only, plus a comment.
- **No behaviour change.** It pins that a non-crypto pending order fills only on a quote with provider `eventTime ≥ eligibleAt`.

## A4. Tick, lot and multiplier (C3, with C4)

- **Files:**
  - `packages/trading-engine/src/fill.ts` (`quoteFill` 26-120);
  - `size.ts` (`qtyForNotional` 91-94, `maxEntryNotional` 4-70);
  - `money.ts` (19-29), only via new functions; the existing 8 dp functions are kept for crypto;
  - `packages/agent-core/src/plan.ts` (924-935: pass `instrumentId`; 803-813, 913-916: an asset-class-aware liquidity requirement).
- **Proposed behaviour:**
  - For registry instruments, BUY prices round **up** to the tick and SELL prices **down**.
  - BUY quantity rounds **down** to the lot, and a quantity below one lot is refused (`BELOW_MINIMUM_QTY`).
  - Notional is `qty × price × multiplier`. Multiplier is 1 for every current instrument, because these are spot proxies and CFDs, never futures.
  - Non-crypto sizing ignores DEX participation and is capped by the existing equity and exposure limits, never by invented liquidity.
- **Invariants:**
  - Solana fills are byte-identical (golden replay).
  - The PCR-1 invariant `exit ≤ held − bought-since-booking` holds with lot-rounded quantities (property test on `exitFence`).
  - A full exit of a non-lot holding closes the position.
- **Tests:** T-C3-1 to T-C3-5 from the original PCR-2, plus planner/settlement `FillQuote` equality per asset class.

## A5. Quote currency → USD (C2)

- **Files:**
  - `fill.ts`, `store.ts` (settle and ledger writes; `applyExternalFill` 742/826), `ledger.ts`;
  - `Fill` gains `fxRate`, `fxRateSource`, `fxRateAgeMs`. These are nullable columns, so this item includes an additive migration.
- **Proposed behaviour:**
  - JPY-quoted fills convert using a fresh qualified USDJPY observation from the same cycle.
  - If none exists, the fill is refused with `FX_RATE_UNAVAILABLE` and nothing is written to the ledger.
  - The valuation of a held JPY position with no rate is a missing mark, never zero P&L.
- **Failure scenario:** a weekend without a rate blocks account-wide BUYs through `MARK_UNAVAILABLE`. This is intended (fail closed). USD/JPY entries stay off until the operator decides weekend handling.
- **Tests:** USD/JPY round-trip golden; stale, missing or future rate; EUR/USD unchanged; ledger identity; replay determinism.

## A6. Observed-spread costs and spread cap (C6)

- **File:** `packages/trading-engine/src/cost-model.ts` (64-139).
- **Proposed behaviour:**
  - The spread cost is `max(configured estimate, observed half-spread)`.
  - A new per-class `maxEntrySpreadBps` (FX 3, metals 5, energy 10, ETF 10) refuses BUYs.
  - A risk-reducing SELL is never refused for spread.
- **These are new conservative caps. No existing limit is changed.**
- **Tests:**
  - a wider observed spread raises the cost;
  - missing bid/ask falls back to the estimate and is flagged;
  - a BUY over the cap is refused;
  - a SELL over the cap fills.

## A7 (optional, from F11-X). Lock the SANDBOX external-fill path

- **Files:** `store.ts` `applyExternalFill` (731-902) and caller `apps/worker/src/sandbox-execution.ts:244-256`.
- **Change:** take `lockAccount` inside the caller's transaction.
- **Test:** concurrent external fills are serialised.
- **Note:** SANDBOX only, never PAPER live. Recommended before A5 touches the same function.

## A8 (optional, from F11-X). Preserve the booked quantity

- **Change:** add a nullable `Order.requestedQty`, set once at booking. The PCR-1 cap then writes only `qty`.
- **Reason:** recommended alongside A4.

## Not requested

- C7 (OANDA practice venue);
- any practice-broker execution;
- any change to the Solana path;
- F11-X chain-impact modelling.

## Independent review requirements

- `quant-safety-reviewer` on every item's diff. A REJECT blocks the merge.
- A separate `regression-reviewer` on A2 and A4 (the transaction path).
- Replay and backtest parity for Solana: byte-identical, compared on a production dump in a scratch database.
- Merge order: A3 → A1+A2 → A7 → A4 (+A8) → A6 → A5. Each merges with `paperEntryInstruments = []`.

## Exact approvals requested now

1. "Approve A1 and A2" (with A3), behind `paperEntryInstruments`.
2. "Approve A4 with A8" and "Approve A6".
3. "Approve A7".
4. "Approve A5". This can wait until EUR/USD has soaked.
