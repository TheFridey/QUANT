# QUANT MVP — Provider Capabilities

Named adapters only. Fixtures are not providers. `EXTERNAL_DEMO_API_KEY` alone does **not** unlock any venue.

## Matrix

| Provider id | Role | Asset classes | Auth env vars | Demo/paper host | Execution | Readiness when unset |
| --- | --- | --- | --- | --- | --- | --- |
| `dexscreener` | Live Solana discovery | SPOT_CRYPTO_PAIR | none | public HTTP | Internal paper only | READY (public) |
| `birdeye` | Token security / candles | SPOT_CRYPTO_PAIR | `BIRDEYE_API_KEY` | birdeye.so | n/a | MISSING_CREDENTIALS → security UNKNOWN |
| `frankfurter_fx` | ECB FX reference marks | FX_SPOT | none | https://www.frankfurter.app/docs/ | Paper marks only (no broker) | READY |
| `fx_stub` | Offline/demo FX stub | FX_SPOT | none | local | Internal paper DEMO | READY (DEMO levels only when fixture supplied) |
| `index_yahoo_delayed` | Delayed index/ETF chart meta | EQUITY_INDEX / research | none | Yahoo chart | Indices NO_EXECUTION | READY / null on failure |
| `index_stub` | Null index stub | EQUITY_INDEX | none | local | NO_EXECUTION | READY |
| `commodity_stub` | Commodity paper proxy | COMMODITY_PROXY | none | local/FIXTURE | Internal paper | FIXTURE or DEMO only |
| `alpaca_paper` | US equity/ETF paper broker | EQUITY_ETF_PROXY | `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` | `https://paper-api.alpaca.markets` | Paper submit/ack/cancel + bracket desired→ACK | MISSING_CREDENTIALS |
| `oanda_practice` | FX practice broker | FX_SPOT | `OANDA_API_TOKEN`, `OANDA_ACCOUNT_ID` | `https://api-fxpractice.oanda.com` | Practice orders + STOP_LOSS/TAKE_PROFIT desired→ACK | MISSING_CREDENTIALS |
| `external_demo` | Facade over Alpaca+OANDA | ETF + FX | named vars above | practice hosts only | Delegates | MISSING_CREDENTIALS |

Optional URL overrides: `ALPACA_PAPER_BASE_URL`, `ALPACA_DATA_BASE_URL`, `OANDA_API_URL`. Non-practice hosts → `INVALID_CONFIGURATION`.

## Product semantics

| Instrument | Tradable product | Notes |
| --- | --- | --- |
| `etf:SPY` | SPDR S&P 500 ETF Trust | Not SPX index level |
| `etf:QQQ` | Invesco QQQ Trust | Not NDX |
| `fx:EURUSD` / `GBPUSD` | Spot FX pair | Quote USD; lot/tick in registry |
| `fx:USDJPY` | Spot FX | Quote JPY — convert before USD risk |
| `commodity:XAUUSD` | Gold USD paper proxy | Spot proxy multiplier=1 USD; not exchange-cleared XAU futures |
| `commodity:WTI` | WTI paper proxy | Spot proxy multiplier=1 USD; CL futures contract size NOT modelled |
| `index:SPX` / `NDX` / … | Index levels | RESEARCH_ONLY / NO_EXECUTION |

## UK / demo eligibility (informational, not legal advice)

- Alpaca paper accounts are offered by Alpaca Securities under US rules; availability of paper signup from the UK can change — check Alpaca’s current account opening docs.
- OANDA practice accounts are offered under OANDA’s fxTrade Practice terms; regional eligibility varies — check OANDA’s developer / practice account pages.
- This project never signs up, funds, or places live-money trades from the agent.

## External verification commands

```bash
# Offline contract tests (no credentials) — must pass
pnpm exec vitest run packages/market-data/src/fx-feed.test.ts

# Credentialed Alpaca paper smoke (BLOCKED without keys)
pnpm build:packages
ALPACA_API_KEY_ID=... ALPACA_API_SECRET_KEY=... \
  node scripts/verify-external-providers.mjs --provider alpaca_paper

# Credentialed OANDA practice smoke (BLOCKED without keys)
OANDA_API_TOKEN=... OANDA_ACCOUNT_ID=... \
  node scripts/verify-external-providers.mjs --provider oanda_practice
```

If credentials are absent, mark **BLOCKED_EXTERNAL_TEST** only for the external verification row — adapter code and offline contracts can still be VERIFIED_OFFLINE.

## Frankfurter for MARKET_DATA_PAPER FX

Free ECB reference rates for delayed FX marks into the common paper engine (not EXTERNAL_DEMO execution). Use when `tradingEnvironment=MARKET_DATA_PAPER` and Solana feed is separate.
