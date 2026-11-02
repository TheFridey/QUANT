# APEX execution ledger

Durable checkpoint for Operation APEX. **On resume, reconstruct state from Git, CI and this file, in that order. Do not trust a chat summary.** Repository rules (`AGENTS.md`, `CLAUDE.md`) override everything here.

## Current state

- Active phase: **E (independent verification) of the first increment**, then F (release) for the non-protected items.
- Branch: `ccr-e2adef27-cgrrwj` (from `main` `c3b23e9`).
- Deployed: unchanged by APEX. The last recorded production deploy is `d2d1526` (`NOT_VERIFIED` from this session).

## Commits

| Commit | Scope | Tests run | Result |
| --- | --- | --- | --- |
| `238399d` | ORACLE budget/autonomy fixes D-01, D-02, D-03 | `budget-store.test.ts` (15), `autonomy.test.ts` (4), `research-budget.integration.test.ts` (3, local Postgres); 19 of the 22 fail on the pre-fix code | pass |
| `2b5baae` | ASCEND-07 portfolio analytics, allocation baselines, read-only CLI | `portfolio.test.ts` (27); look-ahead mutant killed; CLI smoke run on labelled fixture datasets | pass |
| `ae70f8e` | Isolated restore verification drill + RUNBOOKS restore section | `restore-drill.test.ts` (3); local drill ok; truncated-dump and wrong-admin-DB controls fail closed | pass |

The full-suite, typecheck and lint results for the branch head are in the Phase E section below.

## Blockers

| Blocker | Type | What unblocks it |
| --- | --- | --- |
| VPS inspection, deploy, production smoke tests, production restore drill | `BLOCKED_EXTERNAL` | A session with VPS access (SSH or an attached computer); none is configured |
| Merging to `main` and deploying | `BLOCKED_APPROVAL` | Operator approval (standing rule in `docs/ascend/singularity/README.md`: approval before any deploy or production migration) |
| PCR-1 to PCR-5 (protected paths) | `BLOCKED_APPROVAL` | Operator-created unlock; see [`PROTECTED_CHANGE_REQUESTS.md`](PROTECTED_CHANGE_REQUESTS.md) |
| New historical data (FX, longer histories, liquidity history) | `BLOCKED_EXTERNAL` | Network access to providers, and for paid tiers an operator purchase decision |
| Real-data portfolio study | `BLOCKED_EXTERNAL` here | Run `portfolio-cli` on the VPS warehouse (read-only), for example SOL/USDC 1h + GATO 1h |

## Next actions (in order)

1. Address reviewer findings on this increment; re-run the full suite, typecheck and lint.
2. Push the branch and open a PR; wait for green CI (unit, integration, e2e).
3. With operator approval: merge, deploy (packages and worker rebuild; API restart for the D-01/D-03 change; no migration), then run the restore drill on the latest production dump and `portfolio-cli` on SOL/USDC 1h + GATO 1h (read-only), and record both here.
4. With the unlock: PCR-1 (lifecycle fencing) first, since it is the only known correctness gap on the exit path; then PCR-3, PCR-2, PCR-4.
5. ASCEND-10 views for regimes, portfolio and the research registry (no fabricated metrics; every number with its source and timestamp).
6. ASCEND-09 structured feedback over `TradeMemory` (pre-entry snapshots only for entry analysis).
