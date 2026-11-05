# HORIZON diagnosis: why QUANT trades only Solana (5 Nov 2026)

Code at `main` `b8cb0ce`; production `5e26943`. Production figures are read-only queries on 5 Nov 2026. File:line citations are from the code survey; "inferred" marks reasoning not directly observed.

## Production facts

- `EngineControl.config`: `tradingEnvironment=MARKET_DATA_PAPER`, `multiMarketPaperIngest=false`, `marketDataPaperFxIngest=false`, `allowDemoPaperEntries=false`, `entryM5ChangePct=2`.
- `MarketObservation`: **every row ever stored is DexScreener / Solana** (last 24 h: 103,704 rows over 274 pools, all LIVE). Zero FX, ETF, commodity or index observations have ever been stored.
- Orders by base symbol: GATO 131, SIS 19, BNB 13, HALLOWTRUMP 11, whitepaper 7, SOL 4 (all Solana pools, mostly small speculative tokens; SOL itself rarely).
- Strategy instances: `pulse-momentum-v1` (Solana universe), `pulse-momentum-v1-fx` (EURUSD, GBPUSD, USDJPY), `mean-revert-fade-v1` (SPY, QQQ). No commodity instance.
- Instrument registry providers: FX `fx_stub`, ETFs `index_yahoo_delayed`, gold/WTI `commodity_stub`, indices `index_stub`. None of these produces a live quote.
- Credentials (names checked, values not read): `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` set; no `OANDA_*` variables.

## Four independent blocking layers

1. **Ingest.** The worker discovers only DexScreener Solana pairs (`dexscreener.ts` hard-codes `/solana/`). The only non-Solana source in `MARKET_DATA_PAPER` is Frankfurter EUR/USD and GBP/USD, gated by `marketDataPaperFxIngest` (off). `multiMarketPaperIngest` is shown in the UI but **no worker code reads it**. ETFs, gold and WTI have no ingest path outside `FIXTURE`; the gateway has no commodity provider.
2. **Data shape.** Frankfurter rows are once-daily ECB reference rates (DELAYED, no bid/ask) with null liquidity, volume, 5-minute and 1-hour change. Every strategy returns `INSUFFICIENT_DATA` on a null change, and SENTINEL rejects null liquidity/volume (`MISSING_LIQUIDITY`, `MISSING_VOLUME`).
3. **Freshness label.** Real Alpaca and OANDA quotes are labelled DEMO; the risk engine needs LIVE for any BUY (`DATA_DEMO`, `DATA_DELAYED`, `VALUATION_NOT_LIVE`), and the settle fill gate accepts DEMO only with `DATA_MODE=demo`, which ingests nothing, so a DEMO entry can never fill.
4. **Fill economics.** Fills round to 8 dp; registry tick/lot, contract multiplier and quote-currency conversion are not applied (`convertToUsd` has no production caller). USD/JPY would book a ~150 JPY level as `priceUsd` (inferred).

Also: one universal momentum threshold (2% in five minutes) drives every strategy module (inferred: almost never reached by EUR/USD or SPY).

## Per-market verdict

| Market | Observable now | Paper-executable now | First blocker |
| --- | --- | --- | --- |
| Solana pools (incl. SOL/USDC) | Yes, LIVE (DexScreener reference data) | Yes | Quote must be SOL/USDC/USDT; SENTINEL floors; AEGIS UNKNOWN blocks; 2% threshold |
| EUR/USD, GBP/USD | No (flag off). With flag: daily ECB reference only | No | Not ingested; then `INSUFFICIENT_DATA`, `BLOCKED_BY_SENTINEL`, `DATA_DELAYED` |
| USD/JPY | No | No | Not ingested; no JPY→USD conversion |
| XAU/USD | No | No | No provider; no strategy instance; OANDA credentials absent |
| WTI | No | No | As XAU/USD |
| SPY, QQQ | No (Alpaca used only for held-mark refresh, labelled DEMO) | No | Not ingested; DEMO label; DEMO cannot fill |
| SPX, NDX, FTSE, DJI | No | No, by design (research only) | Not ingested |

## What can change without the protected-edit unlock

| Work | Paths | Status |
| --- | --- | --- |
| Provider adapters (OANDA practice pricing/candles/instruments, Alpaca IEX quotes/bars), honest quality metadata, FX conversion and precision helpers | `packages/market-data/src/providers/*`, `gateway.ts`, `packages/shared` (not `strategy.ts`/`execution-gate.ts`) | Allowed |
| Per-market research strategies and configs, ML 2.0 runs | `packages/backtest/src/research/*` | Allowed (research only) |
| Opportunity scanner and dashboard readiness | `packages/analytics`, `apps/api`, `apps/web` | Allowed (read-only) |
| Freshness admission for real non-crypto quotes, fill precision / multiplier / currency, OANDA execution venue | `packages/risk-engine/**`, `packages/trading-engine/**`, `packages/market-data/src/*venue*`/`*broker*`/`execution-*` | **Protected**: change request only; needs the operator's unlock and a safety review |
| Wiring non-Solana instruments into live paper entries | worker pipeline + the protected items above | **Needs operator approval** to activate |
| XAU/USD and intraday FX data | OANDA practice account | **Blocked**: no OANDA credentials; free practice account needs the operator to sign up |
