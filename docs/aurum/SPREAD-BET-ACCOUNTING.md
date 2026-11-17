# AURUM spread-bet accounting and execution state machine

This document also serves as EXECUTION-STATE-MACHINE. The reference implementation is `packages/shared/src/spread-bet.ts` and `spread-bet-lifecycle.ts`: pure, unwired, and covered by 21 + 9 unit tests.

## 1. Units

| Quantity | Unit | Note |
| --- | --- | --- |
| Reference price | USD per troy ounce | from REFERENCE_MARKET_QUOTE |
| Point | `pointSize` USD of price movement | generic profile: $1 |
| Stake | GBP per point | |
| P&L, margin, cash, equity | GBP | **P&L needs no USD→GBP conversion:** the stake is GBP per point by construction |
| Notional | GBP = stake × price / pointSize | an exposure measure, not a cash outlay |

## 2. Prices

- **REFERENCE_MARKET_QUOTE:** the provider's bid/ask (OANDA practice, dealer-indicative). Never presented as a spread-bet broker's quote.
- **SIMULATED_SPREAD_BET_QUOTE:**
  - spread = max(reference spread, scenario spread × pointSize), centred on the reference mid;
  - bid rounds down and ask rounds up to `priceDp`;
  - it carries `derivedFromQuoteId`, the scenario and a "Simulation-derived… Not a broker quote" disclosure;
  - it is derived only after `assessQuoteAdmission` admits the reference quote (freshness, session, tradeability, spread cap).

| Direction | Opens at | Closes at |
| --- | --- | --- |
| LONG | ask | bid |
| SHORT | bid | ask |

Spread is inside the executable prices and is **not** deducted again. A flat market costs exactly one spread per round trip (test: −£1.20 at £2/pt with a 0.6-point spread).

## 3. P&L and booking

- LONG: P&L = (exit − entry) / pointSize × stake.
- SHORT: P&L = (entry − exit) / pointSize × stake.
- Computed in `Decimal` (40 significant digits). No binary floating point touches money.
- Booked to pennies with **ROUND_FLOOR**: profits round down and losses round up, so the ledger never credits more than earned.
- Margin rounds **up** to the penny.
- Round-trip identity (property test, 200 cases): long P&L + short P&L between the same quotes = −(entry spread + exit spread) × stake.

## 4. Cash, margin and equity

Cash moves only on realised P&L and explicit costs.

- **Open:** reserve margin (`MarginReservation`, account currency GBP). Cash is unchanged.
- **Mark:** unrealised P&L = P&L at the current closing-side price.
- **Partial close of fraction f of the stake:**
  - realise f × P&L at the exit price;
  - release f of the reservation;
  - cash += realised P&L.
- **Full close:** realise the remainder, release all margin, and terminate the position.
- **Equity** = cash + Σ unrealised P&L.
- **Available margin** = equity − Σ reserved margin.
- **Margin utilisation** = Σ reserved / equity.
- **Funding:** not modelled in v1, so positions are refused past the cut-off. When modelled, funding is a separate `FUNDING` ledger line per night, never folded into price.
- **Margin closeout:** if equity ≤ closeout × Σ reserved, close the largest loser at the closing-side price. The closeout fraction is per spec, proposed at 50%.

**Invariants** (to implement as DB and replay tests, PCR C8):
- cash = opening cash + Σ realised P&L − Σ costs;
- Σ reservations = Σ margin of open stakes;
- every realised line maps to exactly one fill (unique `(fillId, type)`);
- no line crosses accounts;
- no ledger effect without a fill or funding event;
- legacy `primary` rows are untouched.

## 5. Stake sizing (`sizeStake`)

1. Permitted = equity × riskFraction, with riskFraction in (0, 2%]. The AURUM proposal is 0.25–0.5%.
2. Stop distance = |entry − stop| / pointSize, where entry is the executable side.
   - The stop must be on the correct side of entry, **beyond the current closing-side price** (below the bid for LONG, above the ask for SHORT; otherwise `STOP_INSIDE_SPREAD`), and at least 1 point away.
   - An unknown direction is refused, never treated as SHORT.
   - The stop triggers on the closing side, so the spread is already inside the distance.
3. raw = permitted / (stop distance + slippage allowance), floored to the stake increment.
4. Above the maximum stake: cap at the maximum, which lowers the risk, and flag it.
5. Below the minimum stake: **reject** with `MIN_STAKE_EXCEEDS_RISK`.
6. Margin above available margin: **reject**. Used + new margin above the utilisation ceiling: **reject**.

The output's `estimatedLossAtStopGbp` is labelled "not a maximum loss": ordinary stops fill through gaps (`stopFillPrice`).

## 6. Order actions

`OPEN_LONG`, `OPEN_SHORT`, `REDUCE_LONG`, `REDUCE_SHORT`, `CLOSE_LONG`, `CLOSE_SHORT`, `CANCEL_ORDER`.

- A bare BUY or SELL is never accepted.
- v1 rules (`actionValidFor`): no netting, no pyramiding and no averaging down.
  - Opening is valid only with no live position.
  - Reduce and close must match the position's direction.
  - Only one exit may be pending at a time.

## 7. Position state machine

| From \ event | ENTRY_FILLED | ENTRY_REJECTED | ENTRY_CANCELLED / EXPIRED | EXIT_REQUESTED | PARTIAL_EXIT_FILLED | EXIT_FILLED (zero left) | EXIT_FILLED (partial) | EXIT_CANCELLED (full / partial left) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PENDING_ENTRY | OPEN | REJECTED | CANCELLED | — | — | — | — | — |
| OPEN | — | — | — | EXIT_PENDING | PARTIALLY_CLOSED | — | — | — |
| PARTIALLY_CLOSED | — | — | — | EXIT_PENDING | PARTIALLY_CLOSED | — | — | — |
| EXIT_PENDING | — | — | — | — | — | CLOSED | PARTIALLY_CLOSED | OPEN / PARTIALLY_CLOSED |
| CLOSED, CANCELLED, REJECTED | terminal | | | | | | | |

"—" is `ILLEGAL_TRANSITION`.

**Idempotency and PCR-1 equivalence** (to implement when wiring):
- every order carries a unique `clientOrderId`;
- a fill is unique on `(orderId, fillSeq)`;
- a pending exit stamps the position `lifecycleId` and the stake open at booking. Settle refuses an exit whose lifecycle is no longer the open one, and caps it at the stake still held. This is the PCR-1 fence applied to stake instead of quantity.

## 8. Execution realism (simulation, not broker execution)

- Pending entries fill at the first admitted quote with `eventTime ≥ eligibleAt`. There are no fills at candle highs or lows.
- The scenario spread applies; a stale or one-sided reference quote means no fill.
- Stops fill through gaps at the first closing-side price.
- No fills while the session is closed.
- The Sunday reopen uses the first admitted quote.
- Cost sensitivity runs at BASELINE, ELEVATED and SEVERE. A result profitable only at BASELINE is rejected (RESEARCH-PROGRAMME rule).
