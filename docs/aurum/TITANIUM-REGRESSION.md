# TITANIUM verification and safety review ledger

17 November 2026. IN PROGRESS; results below are scoped to their exact checkout and command. Production remains UNVERIFIED and unchanged by this operation.

## Historical baseline independently verified

PR #82 merged as aec2a80cbc6ca34ef4a32f267d04adbf938e128d. GitHub run 44083988025 succeeded in all three jobs. Job log summary: 238 files, 1,663 tests passed, one skipped. Independent extraction of 34 integration-project file summaries totals 177 tests (including singular `1 test` lines). Browser job reports 14 passed. These are historical CI results, not TITANIUM integration results.

## GENESIS investigation

Separate database `odin_test_titanium_regression`, existing loopback container quant-aurum-odin-test, PostgreSQL 16.13. Applied repository migration SQL in sorted migration order using psql ON_ERROR_STOP; exit 0. No protected migration was edited. This direct disposable setup does not create a Prisma migration-history ledger and is not a production deployment procedure.

Environment isolation: temporary preload outside repository replaces `process.loadEnvFile` with a no-op. NODE_OPTIONS points to it. DATABASE_URL and DATABASE_URL_TEST explicitly point to the separate loopback odin_test database; EXECUTION_MODE=PAPER. No environment-file values printed. Earlier reviewer pure-function runs used standard setup before the autoload was discovered; no DB/provider test was invoked by those pure suites. Future integration runs use isolated variables/preload.

Initial root GENESIS run began while migration was incomplete and failed four missing-ModelVersion-table checks. This was an orchestration error, not evidence of the reported timeout. Once migration completed:

`pnpm vitest run packages/evolution/src/genesis/registry-shadow.integration.test.ts` — 4/4 passed, exit 0, 28.63s overall, 13.229s test execution. Individual registry cases 895ms/1,508ms/1,108ms; shadow cycle 7,877ms includes explicit clock-boundary waits. No transaction timeout changed.

Normal-concurrency `pnpm test` was interrupted after resource pressure: free physical memory approximately 1 GB of 16 GB and an unrelated auth source/import test reported 55.375s against its 20s limit. Concurrent verification jobs were stopped; bounded rerun uses `pnpm vitest run --maxWorkers=2` with unchanged test/transaction timeouts. At sampled instants PostgreSQL had zero ungranted locks. Migration progress repeatedly showed IO/WALSync waits; track_wal_io_timing was off, so sync duration cannot be quantified from pg_stat_wal. Container has no explicit CPU/memory limit (Docker inspect NanoCpus=0/Memory=0), Docker guest budget about 7.54 GiB. These observations support resource-pressure investigation but do not prove the historical five-second failure's cause. Classification remains UNRESOLVED pending repeated/full/sequential evidence.

Registry source `packages/evolution/src/genesis/model-registry.ts:registerModel` prepares/validates artefact before transaction, then inserts ModelVersion and its initial lifecycle event atomically. It does not need a timeout increase based solely on one unrepeatable report. No application change made there.

## Root independent financial re-review

Inspected complete parser, product maths, configured wrapper and tests after reviewer corrections. APPROVE for inactive pure-function integration: bounded Decimal(24,8) inputs; separate 80-digit context; conservative stake/grid/penny checks; derived Decimal(24,2) overflow refusal; configured margin override honoured; requestedRiskFraction above configuration explicitly refused. LONG/SHORT sides and gap semantics preserved. Tests do not establish financial settlement or authority of caller-supplied configuration; C3/C10 remain blockers. The reported removal of an uncommitted extreme-value test cannot be attributed from committed git evidence.

## Root independent feed re-review

Inspected correction e544085 and full provider-circuit/gold-shadow source. APPROVE for inactive integration: mandatory matching generation token; each completion consumes generation; reset invalidates callbacks; OPEN stale completions cannot clear newer state; serialized feed uses abortable timeout and suppresses late completion; actual settlement releases the slot so ignored abort cannot accumulate overlapping calls. Future timestamps do not become watermark, outputs are deep copied, unknown tradeability fails quality, transport errors expose codes only. Read-only adapter change passes signal into GET/body consumption; order-capable provider untouched.

Notes: process-local circuit state is not durable; first completion consumes shared CLOSED generation, so general callers must serialize per key. Typed adapter payload/clock validity remains a dependency contract. Original millisecond timestamp/quote identity is insufficient for tick-complete streaming; persistence proposal requires raw timestamp identity. Feed has no worker schedule, persistent sink or authority to execute.

## Independent API/design review

Separate reviewer inspected readiness controller and global JWT guard registration: no critical/high runtime finding, no DB/provider/write calls. Actual local HTTP behaviour is verified below. C3/C10 design review findings corrected: exact existing action/state enums, nullable prefill price, explicit membership FKs, precise legacy/global stop migration semantics and immutable simulation-quote FK. Retirement function is a structural proposal validator, not fresh account-scoped proof.

## Earlier review checkpoint (superseded below)

## Root independent storage quarantine re-review

Inspected 1733ebf and the complete restore/CLI/boundary source after requesting second-read checksum and aggregate bounds. APPROVE only the quarantined, inactive storage integration: archive/delete execution body removed; no caller-injected approval, real list empty, unconditional durable-audit refusal after approval check. Restore requires explicit loopback odin_test URL and matching current_database(); exact restored bytes are rehashed before bounded decompression, before DB writes; requested run identity, table policy, actual key order/ranges/dedup and chunk/resource envelopes validated. CLI no longer autoloads environment. Original 34c05f2 is rejected for direct operational integration.

This is not acceptance of archive/delete operation or production restore. Underlying deletion findings are DEFERRED/BLOCKED protected audit/transaction design and unreachable in the integrated quarantine. Local mutable filesystem threat model remains a limitation; same-host path checks are not an adversarial production archive trust boundary. Successful synthetic fixture export/restore cannot stand in for a deletion crash-recovery proof.

Build finding resolved operationally by additive `build:tsc` scripts for API/worker and root `build:portable`; default Linux/CI build unchanged. Both installed CLI and core exist. A safe new cache leaf cannot repair insecure ancestor ACLs on this host, and supported temporary native-cache mode also refuses. No global ACL or native-loader security weakened; no dependency/lockfile upgrade. Next uses a separate binding that loads; actual Next build still required.

## Earlier outstanding verification (completed below where authorised)

Post-fix storage review, integration in dependency order, combined targeted/full tests, repeat GENESIS, sequential comparison, lint/typecheck/build and actual worker/browser evidence where the local environment supports it. Record commands and outcomes before closing this checkpoint. No incomplete check is a pass.

## Integration and additional findings

Integrated from verified main dc24992 in order: storage b25674f + quarantine fde151a; feed c006e0d + correction 0121523; product 759c4ab + fixes/contracts/documentation f3ce360. After each step, targeted checks passed: storage 24, feed 53, product/readiness/process 69. Final independent security/boundary reviewer: APPROVE FOR LOCAL INACTIVE INTEGRATION at f3ce360; no new critical/high boundary finding, no protected diff. Root separately reviewed financial corrections because that reviewer authored them.

Full disk-backed runs were interrupted rather than reported passed: one hit low host memory/unrelated source-import timeout; later samples showed repeated fixture TRUNCATE waiting on DataFileImmediateSync with zero ungranted locks. Existing volume PostgreSQL reports fsync=on and synchronous_commit=on; checkpoint sync accumulated 569,348ms across 16 checkpoints at sampling. Control PostgreSQL 16 on tmpfs applied identical migrations in about four seconds with both settings still on. Tmpfs functional tests do not establish physical durable recovery.

First complete combined control run: `pnpm vitest run --maxWorkers=2` with explicit control DB at localhost:55435 and separate Redis at localhost:56379: 239 files passed, two restore-drill import suites failed, four files skipped; 1,673 tests passed and 25 skipped. All 35 integration-project files passed, 179 tests (177 pre-existing plus two quarantine refusals). Windows sandbox limitations explain additional skips versus historical Linux CI; no skip was introduced to conceal a defect. The two import failures reproduce baseline CRLF/hashbang behaviour. `.gitattributes` now pins only scripts/restore-verify.mjs to LF, retaining byte-identical Git source, hashbang and guards. The two repaired suites pass 34/34 with mocks, no DB commands.

GENESIS disk-backed diagnostic `scripts/titanium-genesis-probe.cjs` explicitly refuses any target except the named loopback disposable DB, checks current_database(), and registers five labelled fixture models only. All five succeeded with unchanged Prisma timeout. Wall times 2,079/420/482/429/292ms; maximum individual query durations 481/394/434/412/276ms. Indexed family/version lookup verified by EXPLAIN and zero ungranted locks at sample. Exact trace: evidence/titanium-genesis-probe.json. Historical isolated failure remains UNRESOLVED; local fixture I/O slowness is evidenced ENVIRONMENTAL, not an established application regression.

Portable build layout finding: Nest tsc initially emitted dist/main.js while start expects dist/src/main.js; a startup of the latter loaded an old artifact and returned 404 for the new route. This invalidated that first startup as new-code proof. Dedicated tsconfig.portable.json files now preserve dist/src with rootDir='.' and separate build metadata. Rebuilt API contains AurumController; actual HTTP check gives unauthenticated GET 401, authenticated GET 200, POST 404, account/balance/quote values null, executionEligible=false and researchEligible=false. Exact response contains no token: evidence/titanium-readiness-http.json. Rebuilt worker started with deterministic feed, separate test DB/Redis and external fetch refusal; no provider calls or gold execution.

Full lint command is `pnpm lint --ignore-pattern '.claude/worktrees/**'`: passed. Plain eslint traverses historical nested worktree copies, so that initial invocation was stopped; current repository source and hooks remain checked. `pnpm typecheck`: passed for packages/API/worker/web. Package build passed, with explicit unavailable x86_64 Linux sandbox message on Windows. API/worker portable builds passed after layout correction.

Security finding T-S1 MODERATE: production dependency audit confirms Next 16.4.3 affected by GHSA-mfr8-8qww-v76h (CVE-2026-119790), patched at 16.4.5. The build compiled pages but exited 1 on its security advisory notice. Upstream primary source: https://github.com/vercel/next.js/security/advisories/GHSA-mfr8-8qww-v76h. No use-cache/unstable_cache/cacheComponents pattern found in apps/web; this is repository evidence, not proof of exploitability or current production state. A targeted exact 16.4.5 correction is justified by the advisory rather than speculative upgrade. Final install/audit/build/browser results follow below.

## Verified local code checkpoint 1dfb0ef

`pnpm vitest run --maxWorkers=2`: 1,707 pass / 25 skip, 241 files pass / four skip, zero failure, 572.80s. Integration project: 35 files, 179 tests (two are no-resource retention refusal tests). `pnpm build:portable` passes packages, portable API/worker and Next 16.4.5. Repeated `pnpm typecheck` and scoped full lint pass after the patch. Production audit reports zero known advisories. Next lock diff is restricted to Next/env/matching SWC patch packages.

Portable compiler initially emitted dist/main.js while startup used stale dist/src/main.js. Actual HTTP verification caught the missing new route; separate portable configs now preserve dist/src, and new compiled controller is proven by anonymous401/authenticated200/POST404. Actual worker starts and processes deterministic fixtures. First health ping can be degraded because the lazy Redis health client has offline queuing disabled; later authenticated detail showed Postgres/Redis up, current COMPLETE cycle and pipeline ok. This is local fixture proof only.

Combined compiled CLI rerun: plan0, verify0, unapproved execute2, idempotent restore0 with skippedExisting1/verified1; evidence/titanium-combined-cli.json. The executable is apps/worker/dist/src/ops/retention-cli.js, not the review checkout's targeted compile.

Browser attempts are preserved in evidence/titanium-browser-first-run.txt and titanium-browser-second-run.txt. First run8pass/3fail/3notrun: hardcoded API4318, UI toggle raced rendered acknowledgement, and root omitted the campaign CLI's explicit DB URL. Second run12pass/2fail: host psql missing (also hardcoded DB), and research start correctly refused the dirty tree. No research codeVersion override was used. Fixes keep every assertion: shared API_BASE, wait rendered state, explicit guarded Prisma fixture seeding replacing psql, exact alert-ID matching. Independent reviewer APPROVE. Synthetic campaign consumes only its generated fixture holdout after its test authorisation, never real historical data. Final rerun results follow.

## Final browser acceptance and source checkpoints

Third run: 13 pass / one fail (duplicate valid history text). Fourth at dad8954: 12 pass / two fail (first listitem was an explanatory warning; populated mobile history lacked focus support). Fifth at e01c35c: 13 pass / one fail (positions color-contrast during a possible entrance animation). Exact logs: evidence/titanium-browser-{third,fourth,fifth}-run.txt. No failed run is presented as passing.

e01c35c adds only an accessible name and tabIndex=0 to the native risk-history ul, and scopes the test to that named list. Latest audit values, actor and timestamp are asserted; RUNNING refusal, invalid input, paused save, no automatic resume and restoration remain checked. 3b79f71 waits, with bounded expect.poll, until finite animations stop running before axe; infinite status pulses and every axe rule remain enabled. All failing node summaries are reported. Existing positions animation fades opacity from zero to one in 220ms. This supports a transient rendering hypothesis, not a proven historical diagnosis. Independent reviewer approved both narrow changes.

Frontend rebuild: `pnpm --filter @odin/web build`, exit0, including TypeScript; evidence/titanium-frontend-final-build.txt. Final browser command: `pnpm --filter @odin/web test:e2e` at clean source checkpoint **3b79f71: 14 passed (3.5m), exit0**, no skip. Evidence/titanium-browser-complete.txt. All 23 sections are checked on desktop/mobile. Synthetic paper order lifecycle and synthetic six-unit research/fixture-holdout path passed; no real campaign or sealed historical holdout used.

Final browser environment: explicit DATABASE_URL and DATABASE_URL_TEST point only to 127.0.0.1:55435/odin_test_titanium_e2e_final; Redis 127.0.0.1:56379/1; E2E_WEB_URL=http://127.0.0.1:44317; E2E_API_URL=http://127.0.0.1:44318; EXECUTION_MODE=PAPER. NODE_OPTIONS requires a temporary preload disabling dotenv autoload and external fetches. API/worker use deterministic market fixtures with research scheduling disabled. Frontend build pins that same local public API URL. These are production-shaped artifacts with fixture configuration, not production configuration certification.

Full unit/integration checkpoint precedes final test-only/public-export/accessibility follow-ups: 1,707 pass / 25 skip at 1dfb0ef. Later public-export change passed 53 product tests and package build. Full typecheck/scoped lint passed at the prior compiled checkpoint; changed browser/component files passed targeted eslint and final frontend build typecheck. The complete 1,707-test suite was not rerun after these narrow follow-ups.

Cleanup: own API, worker and web foreground sessions stopped; loopback ports 44317/44318 closed. Only newly created quant-titanium-pg-control and quant-titanium-redis stopped; tmpfs fixtures are disposable. Existing quant-aurum-odin-test and unrelated containers untouched. Root is committed clean after the documentation checkpoint; original ten worktrees stay clean. Storage review checkout retains generated untracked CLI fixture artifacts for review.
