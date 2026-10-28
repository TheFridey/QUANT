# PROJECT GENESIS

Engineering record for the research-pipeline repair on the existing ODIN // QUANT repository. Times are Europe/London.

## Phase 1 — Repository health

Completed 2026-10-28 16:58.

CI run `40724329670` failed in `pnpm typecheck` with `TS2307` on `@odin/shared` inside `packages/analytics`. The workspace link is present in `pnpm-lock.yaml` (`@odin/analytics` → `link:../shared`). The same error reproduces for every Node16 package that imports `@odin/shared` before declarations exist. Analytics was the first dependent the CI log reported.

Root cause: `moduleResolution: Node16` resolves `@odin/shared` only through `package.json` `exports`, which point at `dist/*.d.ts`. `dist` is gitignored. `pnpm typecheck` previously ran `tsc --noEmit` and never produced those declarations. Vitest passed because it aliases workspace packages to source.

Fix: library packages are composite TypeScript projects. The root `tsconfig.json` references them in dependency order. `pnpm typecheck` and `pnpm build:packages` run `tsc -b`, which emits each package's declarations before dependents compile. Consumers keep resolving the published `exports` (declaration files), with `disableSourceOfProjectReferenceRedirect` so a dependency's source is not pulled into another package's `rootDir`.

Local verification against PostgreSQL `odin_test` and Redis on `127.0.0.1`:

- `pnpm install --frozen-lockfile` — exit 0
- `pnpm db:deploy` — 4 migrations applied
- `pnpm test` — 25 files, 73 tests passed
- `pnpm typecheck` — exit 0
- `pnpm lint` — exit 0

Remote CI on this branch is recorded after the push.

## Phase 2 — Forge execution

Completed 2026-10-28 17:13.

`loadSandboxedModule()` no longer runs a predetermined template. Generated TypeScript is checked by a static source gate (named as a static gate, not as isolation), compiled with the TypeScript compiler, and executed only in a separate bubblewrap process.

Runner configuration that was actually probed on this machine:

- Runtime: bubblewrap 0.9.0
- User namespace uid 65534
- Network namespace unshared (`ENETUNREACH` on connect)
- Root filesystem read-only, including the strategy workspace
- Host project directory and secrets are not mounted
- Environment cleared before the strategy runs
- tmpfs `/tmp` capped at 8 MiB
- `prlimit` nproc 16, nofile 32, cpu 3 seconds
- Node heap cap 64 MB
- Wall-clock kill, stdout cap 200 KB
- Dependencies allowlist is empty; the strategy receives only the harness input

The harness passes historical bars strictly before the decision bar and checks that the SHA-256 of the file it imports matches the compiled artifact hash. A logic change in `onBar` changes the returned intent. Template source is labelled `TEMPLATE`. Disabling isolation returns `ISOLATION_DISABLED` and `signalsClaimed: false`.

Runtime containment tests ran here and passed: host environment canary absent, workspace file read blocked, outbound connect blocked, infinite loop terminated, allocation terminated. CI installs `bubblewrap` so the same tests can run there. If `bwrap` is missing, execution stays disabled and those tests skip.

Local: `pnpm exec vitest run packages/evolution/src/forge.test.ts packages/evolution/src/pipeline.test.ts` — 11 passed. `pnpm typecheck` and `pnpm lint` passed after the change.

## Phase 3 — Scientific validation

Completed 2026-10-28 17:20.

Outcomes are separate assessments: `PIPELINE_COMPLETED`, `EXPERIMENT_EXECUTED`, `RESULTS_MEASURABLE`, `STATISTICALLY_EVALUATED`, `OUT_OF_SAMPLE_VALIDATED`, `FORWARD_PAPER_VALIDATED`, `DEPLOYMENT_ELIGIBLE`. A finished pipeline with a null return stays unmeasurable and ineligible. Caller-supplied `testMetrics.returnPct` is ignored. The API no longer invents a sample size from an observation count.

Data integrity blocks invalid timestamps and look-ahead stamps, and reports missing prices, missing liquidity, duplicates, stale rows, provider outage labels, mixed quote currencies, session gaps, and survivorship. The research simulator is chronological, charges fees and slippage through `quoteFill`, sizes through the trading engine, and submits every entry and exit to `evaluateRisk`. Missing prices produce rejections. Replay and demo freshness are rejected by the risk gateway. Statistics mark Sharpe, Sortino, confidence intervals, cost sensitivity, and parameter stability `UNAVAILABLE` when the sample is too small. Walk-forward uses the existing chronological split. Fitting parameters on the evaluation window cannot become out-of-sample validation. `DEPLOYMENT_ELIGIBLE` stays false without explicit promotion, and this flag does not write the live paper engine.

`pnpm exec vitest run packages/evolution/src/validation-engine.test.ts packages/evolution/src/pipeline.test.ts` — 7 passed. `pnpm typecheck` and `pnpm lint` passed.

## Phase 4 — Multi-model research brain

Completed 2026-10-28 17:30.

`ModelRouter` defaults to live mode. Assignments point at Hermes, OpenAI, Anthropic, and a separate `challenge-primary` endpoint (`ODIN_CHALLENGE_API_KEY`). FORGE and CHALLENGE do not share a primary endpoint. Missing keys return `UNAVAILABLE`. Mock endpoints are not called in live mode. Explicit `mode: "mock"` is the only path that returns mock text, and that text is labelled `MOCK`. Injected fixtures report model `FIXTURE` and provenance `FIXTURE`.

Spend is a decimal string in `MemoryBudgetStore` or `FileBudgetStore`. The budget file stores spent USD and a timestamp. It does not store API keys. `health()` reports `CONFIGURED`, `UNAVAILABLE`, or `MOCK` and does not echo secrets. Each call records estimated cost (`costKind: ESTIMATED`) and provenance. A timeout or upstream failure is retried once, then the next endpoint is used. The router timeout races the provider timeout.

No live provider call was made. The optional live test skips unless `ODIN_LIVE_PROVIDER_TEST=1` and `OPENAI_API_KEY` are both set. This environment skipped it.

`pnpm exec vitest run packages/evolution/src/router.test.ts packages/agent-core/src/llm.test.ts packages/agent-core/src/oracle.test.ts` — 9 passed, 1 skipped. `pnpm typecheck` and `pnpm lint` passed.

## Phase 5 — ORACLE bounded research

Completed 2026-10-28 17:34.

ORACLE keeps a persistent queue with thirteen capabilities: performance review, entry-safe trade memory, recurring conditions, weaknesses, falsifiable hypotheses, code-generation requests, sandboxed-test scheduling, baseline comparison, challenge review, weak-candidate rejection, experiment recommendation, deterioration, and a periodic summary. The cycle that produces these items is deterministic supervision. `aiDiscovery` stays false. `MOCK`, `TEMPLATE`, `FIXTURE`, and `UNAVAILABLE` model identifiers cannot be stored as AI discoveries. The cycle does not write strategy source and does not execute generated code.

Limits reject duplicate fingerprints, extra concurrent work, retries above the cap, and daily spend above the decimal cap. Repeated failures terminate the queue. A file snapshot reloads spend and items in a new process. The API enqueue path applies the same limits to `ResearchQueueItem` rows and hardcodes `aiDiscovery` false. Research centre responses include the capability list and the deterministic proposals. Null returns stay null.

`pnpm exec vitest run packages/evolution/src/oracle-research.test.ts` — 2 passed. `pnpm typecheck` and `pnpm lint` passed.
