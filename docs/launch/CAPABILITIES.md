# QUANT — Honest Product Support Matrix (§28)

Statuses reflect **runtime-connected** behaviour as of branch `cursor/quant-release-runtime-cc8a`, not aspirational roadmap cells.

**Legend**

| Label | Meaning |
| --- | --- |
| `VERIFIED_LOCAL` | Local paper path exercised against Postgres worker |
| `IMPLEMENTED` | Code path wired; not independently E2E’d this run |
| `BLOCKED_EXTERNAL` | Needs owner practice credentials / network |
| `UNSUPPORTED` | Not claimed — do not enable |
| `DISABLED` | Explicitly refused (live money) |

| Asset class | Provider / venue | FIXTURE | REPLAY | MARKET_DATA_PAPER | EXTERNAL_DEMO | LIVE |
| --- | --- | --- | --- | --- | --- | --- |
| Solana spot crypto | DexScreener (+ Birdeye optional) | IMPLEMENTED | IMPLEMENTED | VERIFIED_LOCAL (ingest→fill) | UNSUPPORTED | DISABLED |
| FX spot | Frankfurter delayed marks | IMPLEMENTED | IMPLEMENTED | IMPLEMENTED (delayed) | BLOCKED_EXTERNAL (OANDA practice) | DISABLED |
| FX spot | OANDA practice | UNSUPPORTED | UNSUPPORTED | UNSUPPORTED | BLOCKED_EXTERNAL | DISABLED |
| Equity / ETF | Alpaca paper HTTP transport | UNSUPPORTED | UNSUPPORTED | UNSUPPORTED | BLOCKED_EXTERNAL (transport ready) | DISABLED |
| Equity / ETF | `etf_stub` fixtures | IMPLEMENTED | IMPLEMENTED | UNSUPPORTED (no fixture bleed) | UNSUPPORTED | DISABLED |
| Index | `index_*` / research-only | IMPLEMENTED (non-exec) | IMPLEMENTED | RESEARCH_ONLY | UNSUPPORTED | DISABLED |
| Commodity proxy | `commodity_stub` | IMPLEMENTED | IMPLEMENTED | UNSUPPORTED | UNSUPPORTED | DISABLED |

**Execution modes**

| Mode | Booking | Status |
| --- | --- | --- |
| PAPER | Local `commitProposedOrder` only | VERIFIED_LOCAL |
| SANDBOX | Alpaca practice HTTP via `SandboxExecutionGateway` | BLOCKED_EXTERNAL without keys; never local PAPER fills |
| LIVE | Refused | DISABLED |

**Protection:** local paper synthetic OCO armed on fill (VERIFIED_UNIT / integration). Native Alpaca bracket protection is **not** claimed (`protection: false` on practice capabilities).

See `docs/mvp/PROVIDER_CAPABILITIES.md` for adapter inventory. Live money remains a separate gate — never implied by paper/demo green cells.
