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
