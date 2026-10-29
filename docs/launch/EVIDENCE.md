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
| VERIFIED_EXTERNAL | Blocked without owner demo credentials + explicit permission |
| Browser suite in CI | Playwright still local/manual against started stack (not GitHub Actions job yet) |
| Alert ACK UI control | API ack verified; no desk ACK button |

## Browser E2E (branch `cursor/quant-release-runtime-cc8a`, 2026-10-29)

| Check | Result | Notes |
| --- | --- | --- |
| Stack | PASS | api `:4318` + worker + web `:4317`; DB `odin_e2e`; PAPER; LIVE off |
| `pnpm exec playwright test` (apps/web) | **8 passed** | paper-mvp + login/operator/command-centre smokes |
| Label | `VERIFIED_E2E` | Authoritative snapshot/order assertions, not toast-only |
| Failure artifacts | gitignored | `apps/web/test-results/` (trace/screenshot/video), `playwright-report/` |

See `docs/launch/PLAYWRIGHT.md` and `docs/launch/IMPLEMENTATION_STATUS.md`.

## Live money

Disabled. No real orders. SANDBOX stub refuses local PAPER masquerade as external demo.
