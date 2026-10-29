# QUANT Launch — Evidence Log

**Baseline SHA:** `be0923305193cfbf5ccfbf6336663e0b002ca5bf` (PR #3)  
**Working branch:** `cursor/quant-gate-a-correctness-95f1`  
**PR:** https://github.com/TheFridey/QUANT/pull/4  
**Date:** 29 October 2026 (Europe/London)

## Local checks (this agent)

| Check | Result | Notes |
| --- | --- | --- |
| `pnpm typecheck` | PASS | packages + api/worker/web |
| `pnpm lint` | PASS | after Gate A–D |
| `pnpm test` | 321 passed, 4 failed, 29 skipped | Failures require `bwrap` (bubblewrap); absent in this VM. CI installs bubblewrap. |
| `pnpm build` | PASS (Gate D CI change) | exercised via CI job |

## Unit regressions added/extended (VERIFIED_UNIT)

- D01 execution-context pin/load helpers
- D03 eligible-observation bounds / preferIngest / null-env
- D04 reconstruct-budget open+HELD; reservations consume/remainder
- D05 safety PROTECTION_RECOVERY suspends entries
- D06 position-key `primary:fixture:etf:SPY`; desired-only coverage
- D08 held-refresh routing/fairness
- D09 execution-gateway SANDBOX stub
- D10 practice-url allowlists
- D11–D15 strategy instances, pulse exits, market admission, promotion
- D16 ops-controls; D19 receipt/idempotency
- D25 token-revocation

## Not claimed

| Level | Status |
| --- | --- |
| VERIFIED_DB | Pending disposable Postgres race/protection integration |
| VERIFIED_WORKER | Pending full stage-runner soak with fake venue |
| VERIFIED_BROWSER | Pending Playwright against managed services |
| VERIFIED_EXTERNAL | Blocked without owner demo credentials + explicit permission |

## Live money

Disabled. No real orders. SANDBOX stub refuses local PAPER masquerade as external demo.
