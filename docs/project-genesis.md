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

## Phase 6 — ARCHIVIST trade intelligence

Completed 2026-10-28 17:35.

Reconstruction keeps BEFORE (market structure, momentum, liquidity, volume, volatility, agent signals, historical context, strategy version, entry hypothesis, risk calculations), DURING (price path, MFE, MAE, slippage, liquidity changes, regime, risk events, execution events), and AFTER (exit rationale, net P&L, costs, compliance, post-exit behaviour, missed opportunities, unexpected outcomes) as separate records. Entry features are built only from `memoryForEntryDecision`, which drops AFTER and post-exit rows and omits P&L and exit fields. Winner and loser cohorts require a decimal net P&L. A missing net result is `UNMEASURABLE` and is not counted as a winner. The API exposes `/evolution/memory/reconstruction` and `/evolution/memory/factors` from persisted `TradeMemory` rows.

`pnpm exec vitest run packages/evolution/src/archivist.test.ts packages/evolution/src/challenge.test.ts` — 6 passed. `pnpm typecheck` and `pnpm lint` passed.

## Phase 7 — Dashboard

Completed 2026-10-28 17:41.

The command centre keeps its existing shell. New modules read persisted API state:

- Research Operations: `/evolution/research` queue, capability list, limits, and deterministic proposals
- FORGE Monitor: `/evolution/forge` experiment reports
- AI Model Operations: `/evolution/models` health, including `UNAVAILABLE` when no key is configured
- Strategy Evolution: existing genome and lifecycle audits
- Data Integrity: `/evolution/integrity` over stored observations
- Research Confidence: `/evolution/confidence` outcome tones

`PIPELINE_COMPLETED` uses the recorded/open tone. The confidence badges do not use the profit colour. A pipeline stage is not shown as a successful strategy.

Browser check on 2026-10-28 17:40 Europe/London with headless Chrome: logged in as the local admin, opened Research Operations, FORGE Monitor, AI Model Operations, Strategy Evolution, Data Integrity, Research Confidence, and Research Memory at desktop width, and Research Confidence at 390px. Confidence badge class for `PIPELINE_COMPLETED` was `border-border text-muted`. Panel copy showed return unavailable. FORGE showed no stored reports. Integrity showed one usable observation. Model operations showed `challenge-primary` and unavailable endpoints. Research operations showed `REVIEW_PERFORMANCE`.

`pnpm typecheck` and `pnpm lint` passed.

## Phase 8 — Acceptance

Completed 2026-10-28 17:45.

`packages/evolution/src/acceptance.test.ts` drives a fixture provider whose model field is `FIXTURE`. That fixture is not a live model. No live provider call was made. With bubblewrap available, two compiled sources produced different signals (`HOLD` versus `ENTER_LONG`) and different source hashes. The pipeline report verifies, keeps a null return unmeasurable, and proposes a follow-up experiment. FORGE and CHALLENGE endpoints stay distinct.

Missing prices produce no fills and a null return. Demo freshness does not become a measured entry. An unconfigured router returns `UNAVAILABLE` and does not record a successful model call. A generated source that reaches for the host canary does not surface that value. `reviewPromotion` leaves `appliedToPaperEngine` false for both unreviewed and approved inputs, so this phase does not write `EngineControl`. Autonomy schema rejects real-money execution and unreviewed deploy. `submitOrder` remains the paper-engine path and contains no live-broker submission. Deterministic ORACLE proposals keep a null return and `aiDiscovery: false`. Entry features omit after-trade P&L.

`pnpm exec vitest run packages/evolution/src/acceptance.test.ts` — 2 passed. `pnpm test` — 29 files, 96 passed, 1 skipped (optional live provider). `pnpm typecheck` and `pnpm lint` passed.

## Phase 9 — Operator promotion and the bubblewrap probe

Completed 2026-10-28 19:57 Europe/London.

Review and promotion are separate. `reviewPromotion` and `recordStrategyReview` still return `appliedToPaperEngine: false` and leave the paper slot untouched. `promoteToPaperEngine` is the write. It requires caller `OPERATOR`, a non-empty operator id, and `authorised: true`. Callers `ORACLE`, `FORGE`, and `MODEL` are refused. Missing review, a rejected review, a source hash that differs from the compiled artifact's source hash, a null return, and missing statistics are refused, and the slot stays as it was. When the existing scientific gates pass, the primary paper slot takes the reviewed strategy id, version, source hash, artifact hash, and `StrategyConfig`. The audit stores the operator id, timestamp, those hashes, and the previous paper strategy identity. `POST /evolution/promote` is an admin route. It takes the operator id from the authenticated user and sets the caller to `OPERATOR`. The request body cannot choose another caller. On success the service updates `EngineControl` id `primary`: `config` is the promoted paper strategy, and `activeStrategy` stores the version, hashes, and audit. `submitOrder` is unchanged and remains the paper-order path.

The CI probe now uses the runner's library mounts (`/usr`, `/lib`, `/lib64`) together with a user namespace, a network namespace, uid 65534, gid 65534, `/proc`, `/dev`, and a cleared environment, then runs `/usr/bin/true`. The strategy runner still adds its work directory, tmpfs, `prlimit`, and the Node binary. Local command on bubblewrap 0.9.0:

`bwrap --unshare-user --unshare-net --die-with-parent --uid 65534 --gid 65534 --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --proc /proc --dev /dev --clearenv -- /usr/bin/true`

Exit 0. Stdout empty. Stderr empty.

Verification on 2026-10-28 19:56–19:57 Europe/London:

- `pnpm exec vitest run packages/evolution/src/promotion.test.ts packages/evolution/src/sandbox-probe.test.ts apps/api/src/promote-paper.test.ts` — PASS, 13 passed
- `pnpm db:deploy` — PASS, `20261028190000_paper_strategy_promotion` applied to `odin` and `odin_test`
- `pnpm test` — PASS, 32 files, 109 passed, 1 skipped (optional live provider in `packages/evolution/src/router.test.ts`)
- `pnpm typecheck` — PASS
- `pnpm lint` — PASS

The promotion tests supply the scientific gate inputs. They do not measure a market sample, and this phase does not claim a statistically validated strategy. No live model call was made. The service test observed the `EngineControl` primary update on a Prisma double: after a successful operator promotion `entryM5ChangePct` was `"3"`, and a later unreviewed revision left that value in place. A worker cycle was not started after that write.

## Remaining limitations

- Bubblewrap is a user-namespace sandbox with the host `/usr`, `/lib`, and `/lib64` trees mounted read-only so Node and `prlimit` can start. It is not a virtual machine and it does not install a seccomp profile. If `bwrap` is absent, generated-code execution stays disabled and signals are not claimed.
- No live model call has been made. Unconfigured providers stay `UNAVAILABLE`.
- Promotion eligibility in these tests comes from supplied gate inputs. A null return stays unmeasurable and is refused. No market sample was statistically validated.
- The observed paper-engine write is the primary slot in `promotion.test.ts` and the `EngineControl` update recorded by `promote-paper.test.ts`. That test uses an in-memory Prisma double. It does not read a PostgreSQL row back, and it does not run a worker cycle.
- The existing terminal config editor can still patch `StrategyConfig` while the engine is paused. Research callers have no promotion path.
- Equity index data is unchanged: the adapter does not invent live index prints.
- Docker is not installed on this machine. Isolation uses bubblewrap.
- GitHub-hosted Ubuntu images can block unprivileged user namespaces through AppArmor. CI clears `kernel.apparmor_restrict_unprivileged_userns` when that knob exists. The probe uses the runner's library mounts. If bubblewrap still cannot start, the workflow logs the probe failure and the pipeline test expects `signalsClaimed: false`.
