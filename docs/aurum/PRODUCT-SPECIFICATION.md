# AURUM product specification registry

## 1. Broker evidence (searched 17 Nov 2026; not verified on a deal ticket)

| Provider | Point | Min stake | Spread | Margin (retail) | Funding | Source | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| IG Spot Gold (DFB) | $1 move per point (third-party blog); IG's help table lists "$100" contract and £5 bet size | **conflicting:** help table "min 0.6"; UK market page "min size 0.20"; AU page 0.05; a third-party blog reports £0.50 accepted on the deal ticket | from 0.3 points | 5% (1:20) | daily funding on undated spot | [IG margins](https://ig.com/uk/charges/margin), [IG commodities spread-bet details](https://www.ig.com/uk/help-and-support/spread-betting-and-cfds/fees-and-charges/what-are-igs-commodities-spread-bet-product-details), [IG gold](https://www.ig.com/uk/ig-commodities/gold) | not verifiable without a deal ticket |
| CMC Markets Gold Cash | "last large number" of the quoted price | **conflicting:** FAQ says 50p for commodities; a newer FAQ says from 1p, instrument-dependent | not stated on the instrument page | from 5% | holding cost on cash | [CMC spread-betting margins](https://cmcmarkets.com/en-gb/spread-betting-margins), [CMC gold cash](https://cmcmarkets.com/en-gb/instruments/gold-cash), [CMC spread-betting FAQ](https://www.cmcmarkets.com/en-gb/support/faqs/products/spread-betting) | not verifiable |
| Spreadex | — | — | — | — | — | not searched yet | open |

**Consistent across sources:** 5% retail margin for gold, which matches the FCA retail CFD/spread-bet leverage cap of 20:1 for gold (`INFERRED` from regulation; confirm).

**Not consistent:** minimum stake, point definition and typical spread.

**Decision:** use a **generic, labelled simulation profile**. AURUM claims no parity with any broker.

## 2. Initial profile `aurum-generic-gold-dfb-gbp-v1` (`packages/shared/src/spread-bet.ts`)

| Field | Value | Basis |
| --- | --- | --- |
| Provenance | GENERIC_SIMULATION | the brokers above cannot be verified |
| Reference | `commodity:XAUUSD` (OANDA practice, DEALER_INDICATIVE) | the only connected gold source |
| Point | $1.00 of XAU/USD per point | simplest honest definition; matches the reported IG convention |
| Stake | min £0.50, increment £0.01, max £5.00 per point | min is conservative versus the conflicting broker figures; max is an AURUM risk cap, not a broker limit |
| Margin | 5% of GBP notional (stake × price) | FCA retail cap; both brokers list it |
| Spread | baseline 0.6 / elevated 1.5 / severe 4.0 points | baseline is twice IG's "from 0.3"; never narrower than the reference spread |
| Price precision | 2 dp | |
| Funding | **not modelled**, so overnight exposure is disabled | holding past the funding cut-off is refused until funding is modelled |
| Guaranteed stops | not modelled | ordinary stops only; gaps fill through |

Any change to a field creates a new spec id; the spec object is frozen.

## 3. Minimum-stake feasibility (from `sizeStake`)

Formula: maximum stop distance = permitted risk / min stake − slippage allowance (2 points).

| Equity | Risk/trade | Permitted | Max stop at £0.50 min |
| --- | --- | --- | --- |
| £10,000 | 0.25% | £25 | 48 points ($48) |
| £10,000 | 0.50% | £50 | 98 points ($98) |

- Intraday stops of tens of dollars fit inside these limits.
- Stops on daily swings at 0.25% risk may not, depending on the gold price and ATR (`UNVERIFIED`; Campaign 01 measures the XAU ATR distribution).
- When a stop is too wide for the minimum stake, `sizeStake` returns `MIN_STAKE_EXCEEDS_RISK`. **Risk is never raised to reach the minimum.**

## 4. TITANIUM numerical domain (implemented, inactive)

This is a representation contract, not approval of a balance, risk configuration or execution threshold. The current spot account monetary fields use PostgreSQL `Decimal(24,8)` (`packages/shared/prisma/schema.prisma`); draft C3 proposes prices at `(24,8)` and booked GBP at `(24,2)`. No schema is changed here.

| Input | Representation and semantic constraint |
| --- | --- |
| Equity / initial balance | Decimal string, strictly positive, magnitude below `1e16`, at most 8 meaningful decimal places. Initial balance remains the unapproved proposal of GBP 10,000. |
| Available cash / margin; used margin | Same representation, nonnegative. Cash settlement is not implemented; the sizing inputs are available/used margin, not a new ledger. |
| Price / stop | Same representation, strictly positive. Stops must lie beyond the current closing side, on the loss side, with at least one product point of distance. |
| Stake / point size | Same representation, strictly positive. Stakes must be on the product increment and at most its maximum. Entry sizing additionally requires the minimum. Partial-close calculations may use an increment below the entry minimum. |
| Risk / margin fraction | Same representation, greater than zero. Margin and utilisation at most 1. Raw sizing risk at most 0.02; account wrapper risk at most the validated configured fraction, whose ceiling remains 0.005. These are fractions, not percentage numbers. |
| Spread / slippage allowance | Same representation, nonnegative. Cost scenarios must be complete and ordered. Reference ask must exceed bid. Derived quotes must remain representable. |
| Funding | No funding calculation exists. `overnightFundingModelled:true` is refused. Overnight and weekend account exposure stay unsupported. |
| Booked GBP / derived notional | Absolute magnitude below `1e22`, from draft C3 `Decimal(24,2)`. GBP booking checks again after rounding, to refuse rounding into overflow. Intermediate P&L may carry fractional pennies until booking. |

Inputs use decimal syntax only, with an optional exponent from -24 to +24 and at most 64 characters. The exponent range follows the 24-digit representation; the character cap accommodates signed, zero-padded and scientific forms while bounding parser work. Values with more than eight meaningful fractional places are refused rather than rounded into a different input. Meaningful zeroes are normalized, so `1.0000000000` remains exactly 1. `1e400` is finite in decimal.js, but cannot fit these representations and is refused before arithmetic; numeric JavaScript `1e400` is Infinity and is also not an accepted string input.

Spread-bet arithmetic uses an isolated decimal.js context at 80 significant digits: two 24-digit inputs can form a 48-digit product; division by an eight-decimal point size retains ample guard digits before penny booking. The legacy monetary context and legacy risk defaults are unchanged. Stake rounding computes the permitted booked risk directly, then floors to the stake increment, with a final loss-budget assertion. Its work does not grow with the number of tiny stake increments.

The account wrapper applies the configured margin rate as well as the minimum stake. A caller requesting risk above the configured fraction receives `RISK_ABOVE_CONFIGURED`; it is never silently clamped. The configuration argument must eventually come from an authorised, versioned, per-account store. This pure helper cannot authenticate a caller-supplied configuration; that is a C10 blocker, and the helper remains unwired.

Margin reservation, cash/ledger mutation, funding, actual partial-close allocation, and concurrency remain C3/C6/C8 implementation work. The pure P&L function supports a partial stake, but does not prove ledger penny conservation or margin release. Booking partial fills requires a documented residual-penny policy and database invariants before activation. Evidence: `TITANIUM-PRODUCT-REVIEW.md` and the exact targeted test results recorded there.
