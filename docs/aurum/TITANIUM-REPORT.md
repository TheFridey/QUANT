# TITANIUM engineering checkpoint — 17 November 2026

Local inactive integration is implemented and independently reviewed. The complete platform acceptance checkpoint remains BLOCKED on protected implementation and operator evidence. Nothing is deployed, activated, pushed or merged to main by this operation. No AURUM or production account was created; disposable regression fixtures are separate.

## Exact baseline and integration

Starting root was clean on aurum/04-product. All original worktree statuses were subsequently inspected; original ten Claude worktrees remained clean and untouched. The existing stash is retained. Existing unlock marker is unexplained, unused and unchanged.

| Ref at takeover | Exact SHA |
| --- | --- |
| main / remote main | dc24992209b6790fa978ded9d61c0a61bdf80b9a |
| aurum/01-storage | 34c05f24704bdcfd4bd3a00b72670b7b78e42ea0 |
| aurum/03-market-data | 0cc864c0eefda5818d3f82cf9578d3d223f1a70c |
| aurum/04-product | a86f4b7a1693a6dfa003f6f2a178f1ddd89d8590 |

Original heads are preserved. All three branches have the same main merge base. Production SHA is UNVERIFIED: aec2a80cbc6ca34ef4a32f267d04adbf938e128d is a reported deployment, independently confirmed as the PR #82 merge only. Production inspection was not authorised.

Dedicated branch: `aurum/05-titanium-integration`, based on verified main. Reviewed integration order:

| Commits on integration branch | Content |
| --- | --- |
| b25674f → fde151a | storage implementation, immediately corrected to deletion quarantine and disposable recovery |
| c006e0d → 0121523 | feed implementation and completion/provenance/timeout corrections |
| 759c4ab → f3ce360 | product implementation and domain/margin corrections, read-only API, takeover evidence |
| 1dfb0ef0f6f5c62ace551e089f6b12539fcac076 | exact Next security patch, portable entrypoint layout, LF portability and diagnostic script |

Final evidence and test-harness commits follow the compiled code checkpoint above. No remote branch or PR was created. `git diff main...HEAD` contains no protected risk/trading/schema/execution-gate/strategy/promotion/workflow/hook edits.

## Independent findings and corrections

- Storage original branch: REJECTED for operational integration. Lock check/use race, absent durable deletion audit, filesystem replacement/path/resource hazards, evidence-writer race and overstated capacity/backup/WAL assurances were found. The unsafe delete body was removed; real frozen allowlist remains empty, and even a future approval encounters a durable-audit hard block. Restricted recovery validates target, policy, run, content/key identity, reread checksum and memory bounds. This is a quarantine, not proof of archive/delete correctness. Findings and exact approval package: TITANIUM-STORAGE-REVIEW.md.
- Product: HIGH extreme finite Decimal inputs (`"1e400"`) and HIGH ignored configured margin corrected. A bounded decimal representation contract, derived overflow checks, isolated arithmetic, direct conservative stake rounding and caller-risk refusal have tests. LONG/SHORT sides, spread-once P&L and gap pricing preserved. Root independently reviewed the fixes. No settlement/account authority is inferred from these pure tests. Attribution of an allegedly removed uncommitted test remains UNVERIFIED. See TITANIUM-PRODUCT-REVIEW.md and PRODUCT-SPECIFICATION.md.
- Feed: stale/duplicate/missing-token completions, reset fencing, future watermark poisoning, state mutation, unknown tradeability and transport timeout corrected. No executable quote, schedule, persistence or provider invocation was added. Root post-fix review approves inactive integration. See TITANIUM-FEED-REVIEW.md and FEED.md.
- Security/build: @swc/cli was installed; native cache ancestor ACL validation caused the misleading build failure. No ACL weakened. Portable compiler configuration now emits the exact dist/src/main.js expected by startup; an initial stale-path startup was explicitly excluded from verification. Restore import failure was the pre-existing CRLF/hashbang issue, fixed with one scoped LF attribute and no logical restore-script change. A confirmed moderate Next advisory was corrected to exact 16.4.5; lock changes are confined to Next/env/SWC. Production audit now reports zero known advisories. Upstream: https://github.com/vercel/next.js/security/advisories/GHSA-mfr8-8qww-v76h.
- Command API: GET /api/aurum/readiness inherits existing JWT auth, has no mutation/provider/database access and returns unavailable observations/account values as null, research/execution false. Actual HTTP proof: anonymous 401; authenticated GET 200; authenticated POST 404. Evidence JSON excludes credentials/tokens.

Separate reviewer approved combined safety/security scope and the later build/security delta. Root provides independent mathematical and storage/feed post-fix sign-off. No unresolved high finding is reachable as an enabled new capability; underlying storage/settlement/isolation design deficiencies remain explicit approval blockers.

## Verification and database evidence

Environment: Windows x64 Node 22.19.0, pnpm 10.33.4; existing disk-backed PostgreSQL 16.13 plus a separate tmpfs PostgreSQL 16 control. Test URLs are explicit loopback odin_test databases. Autoload is disabled with a temporary process preload; browser-stack processes additionally refuse external fetches and use deterministic fixtures. No actual provider/production traffic or sealed holdout consumption. Existing pure tests invoked the standard setup before its dotenv autoload was discovered; no values were printed and no provider/database test was invoked by that pure run.

| Command / evidence | Result |
| --- | --- |
| GitHub PR #82 / CI 44083988025 | historical 1,663 pass, one skip, 238 files; independently summed 177 integration tests; browser 14 pass |
| Storage targeted four files, --maxWorkers=2 | 24 pass |
| Feed targeted three files | 53 pass |
| Product/readiness/process targeted five files | 69 pass |
| Restore-import two suites after LF correction | 34 pass, no skip; no SQL executed by mocks |
| `pnpm vitest run --maxWorkers=2` final combined | **1,707 pass, 25 skip; 241 files pass, four skip; 572.80s**, zero failure |
| Integration summaries within final combined run | 35 files / 179 tests pass; two are explicit no-resource retention quarantine tests |
| GENESIS sequential --maxWorkers=1 | 4/4 pass; 13.81s total, 10.06s tests |
| Disk-backed GENESIS probe, five registrations | 292–2,079ms wall; maximum individual query 481ms; expected family/version index used; no waiting lock sampled |
| Actual storage CLI | 11 expected exit/output scenarios pass; fixture restore inserts/verifies one row; repeat skips/verifies it; no retention deletion performed |
| Combined compiled retention CLI | plan/verify/unapproved-execute/idempotent-restore exits 0/0/2/0; existing fixture verified, no deletion |
| `pnpm build:packages` | pass; Linux seccomp artifact unavailable on Windows, explicitly reported |
| `pnpm typecheck` | pass, repeated after the Next patch and final build |
| `pnpm lint --ignore-pattern '.claude/worktrees/**'` | pass; excludes unrelated historical checkouts, not current source |
| `pnpm audit --prod --json` after exact Next patch | 0 known advisories in every severity |
| Combined production-path retention CLI | plan 0, verify 0, unapproved execute 2, restore existing fixture 0 (skipped/verifies one); evidence/titanium-combined-cli.json |
| `pnpm build:portable` | pass: packages, portable API, portable worker and Next 16.4.5 production build, exit 0 |
| Public account-config export follow-up | package build and 53 product tests pass after 1270759 |
| `pnpm --filter @odin/web build` after accessibility fix | pass, including frontend TypeScript; explicit local API URL compiled into fixture bundle |
| `pnpm --filter @odin/web test:e2e` at 3b79f71 | **14 passed (3.5m)**, zero failure/skip; evidence/titanium-browser-complete.txt |

The 25 skips include unavailable Linux sandbox capabilities and existing optional/provider tests; they are not a Linux security acceptance claim. Historical green CI does not substitute for new-branch Linux CI. Full normal-concurrency attempts were interrupted under memory pressure; fixture SQL on the old Docker volume repeatedly waited on DataFileImmediateSync without ungranted locks. Both databases kept fsync and synchronous_commit on. Tmpfs tests establish SQL/functional behaviour, not physical crash durability. No timeout was increased. Historical GENESIS timeout classification remains UNRESOLVED; local environmental I/O pressure is VERIFIED separately and is not proof of its original cause.

Actual CLI evidence: evidence/titanium-storage-cli.json and evidence/titanium-combined-cli.json. HTTP: evidence/titanium-readiness-http.json. Probe: evidence/titanium-genesis-probe.json; reproducible disposable-only script at scripts/titanium-genesis-probe.cjs. Detailed attempts, corrections and limitations: TITANIUM-REGRESSION.md.

## Approval boundaries and next operation

Prepared: per-stage feed architecture/quality economics; immutable bounded persistence schema/resource proposal; C3 GBP entities and C10 account identity/control/membership/ownership constraints; reversible crypto retirement with protective-watch preservation; historical dataset matrix and exact operator read-only trial queries. No current spread percentiles, dataset hashes, account entitlement, source counts or production obligations were fabricated. No guessed trial subtraction/declaration is accepted.

Protected blockers: durable RetentionRun/Batch/Audit transaction protocol; immutable gold quote/snapshot persistence; C3/C10 schema and runtime adapters; actual settlement/margin/partial-close accounting; global/account risk authority. Production archive/delete, account creation, crypto retirement and gold paper activation remain unauthorised. Underlying deletion defects are DEFERRED/BLOCKED rather than labelled repaired.

Operator decisions D1–D13, exact requested scope, risks, reversibility and excluded actions are in TITANIUM-APPROVAL-PACKAGE.md and linked storage/feed proposals. Recommended next operation: approve the bounded read-only production metadata package (D8) to reconcile counting/storage/dataset facts, then separately name the protected retention audit and C3/C10 implementation scopes. No unlock reuse, deployment or activation follows automatically from either approval.

## Final build/browser completion

Full portable build passed at the compiled code checkpoint; the frontend production build passed again after e01c35c. Browser acceptance at `3b79f71` passed all 14 tests in one run: desktop/mobile axe across 23 sections, authentication/session revocation, scanner, controls, synthetic paper order/fill/protection/close, fixture alert acknowledgement, synthetic six-unit research campaign with its expressly authorised fixture holdout, and risk audit history. Real historical campaigns and sealed holdouts were not used.

Earlier browser attempts remain recorded, including 13-pass runs with audit-locator or mobile accessibility failures. Repeated histories exposed a genuine non-focusable scroll region, corrected with a named keyboard-focusable native list. The test now identifies that list and verifies the newest change, actor and timestamp. A later positions-page contrast failure was consistent with the existing 220ms opacity entrance animation; bounded finite-animation settlement now precedes axe without suppressing rules, infinite status pulses or section coverage. The exact historical cause of that transient contrast sample is not proven. Final 14/14 is observed evidence, not an erasure of the failed attempts. Independent reviewer approved both narrow changes.

Final source checkpoint: `3b79f71` on `aurum/05-titanium-integration`; subsequent commit records documentation/evidence only. Original branch refs and stash are preserved. No protected path changed. The native SWC default build remains host-blocked by ancestor ACL validation; the tested portable production artifacts do not establish Linux CI, physical crash durability, provider connectivity or production readiness.
