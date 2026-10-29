# QUANT Launch — Capability Matrix (stub)

Asset × provider × account-mode matrix. Statuses are stubs until Gate B/D evidence lands.

**Legend:** `STUB` = not assessed this gate · `IMPLEMENTED` · `OBSERVED_PAPER` · `EXTERNAL_DEMO` · `UNSUPPORTED` · `BLOCKED`

| Asset class | Provider | FIXTURE | REPLAY | MARKET_DATA_PAPER | EXTERNAL_DEMO |
| --- | --- | --- | --- | --- | --- |
| SPOT_CRYPTO_PAIR | `dexscreener` | STUB | STUB | STUB | UNSUPPORTED |
| SPOT_CRYPTO_PAIR | `birdeye` | STUB | STUB | STUB | UNSUPPORTED |
| FX_SPOT | `frankfurter_fx` | STUB | STUB | STUB | UNSUPPORTED |
| FX_SPOT | `fx_stub` | STUB | STUB | STUB | UNSUPPORTED |
| FX_SPOT | `oanda_practice` | UNSUPPORTED | UNSUPPORTED | UNSUPPORTED | STUB / BLOCKED |
| EQUITY_ETF_PROXY | `etf_stub` | STUB | STUB | STUB | UNSUPPORTED |
| EQUITY_ETF_PROXY | `alpaca_paper` | UNSUPPORTED | UNSUPPORTED | UNSUPPORTED | STUB / BLOCKED |
| EQUITY_INDEX | `index_*` | STUB | STUB | STUB | UNSUPPORTED |
| COMMODITY_PROXY | `commodity_stub` | STUB | STUB | STUB | UNSUPPORTED |

See also `docs/mvp/PROVIDER_CAPABILITIES.md` for named adapter details. Live money remains a separate gate — never implied by paper/demo green cells.
