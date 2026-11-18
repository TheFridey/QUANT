# CATALYST: storage pressure and legacy crypto retirement

18 Nov 2026. Retirement code is implemented and tested but **not activated**. Production is unchanged.

## 1. What is actually using the disk (VERIFIED_PRODUCTION, D8)

| Item | Bytes |
| --- | ---: |
| `/` total / used / free | 146 GB / 102 GB / 44 GB (70%) |
| PostgreSQL `quant` database | 14 GB |
| **Used by everything else** | **about 88 GB, UNVERIFIED breakdown** |

The database is less than a seventh of used space. Likely other consumers, none of them measured:
- `/srv/quant/backups`: nightly dumps of 1.1–1.95 GB, plus pre-deploy dumps; no dump retention policy is documented;
- `/srv/quant/releases` snapshots (68 MB each);
- PostgreSQL WAL and logs;
- journald;
- the other sites on the VPS (scalesmiths.co.uk, veteranfinder.co.uk).

**Required next inspection (D14, read-only, not yet approved):**

```bash
ssh scalesmiths 'df -h /; du -xsh /srv/quant/* /var/lib/postgresql /var/log 2>/dev/null; ls -l --time-style=+%F /srv/quant/backups | tail -40; du -sh /srv/quant/backups; sudo -u postgres psql -d quant -XAt -c "SELECT pg_size_pretty(sum(size)) FROM pg_ls_waldir()"; journalctl --disk-usage'
```

```sql
-- inside BEGIN READ ONLY; statement_timeout 30s; uses the receivedAt / createdAt indexes
SELECT source, count(*) FROM "MarketObservation" WHERE "receivedAt" > now() - interval '24 hours' GROUP BY 1;
SELECT agent, decision, count(*) FROM "AgentDecision" WHERE "createdAt" > now() - interval '24 hours' GROUP BY 1,2;
SELECT count(*), pg_size_pretty(sum(pg_column_size(plan))) FROM "CyclePlan" WHERE "plannedAt" > now() - interval '24 hours';
SELECT count(*) FROM "OpportunityFunnelEvent" WHERE "createdAt" > now() - interval '24 hours';
```

If dumps are kept indefinitely, they are probably the largest and fastest-growing consumer: about 2 GB a night is 60 GB a month. Dump retention, for example keeping 7 daily and 4 weekly dumps, is then worth more than table archival. It is an operator decision and is not implemented here.

## 2. Measured table growth (VERIFIED_PRODUCTION, two snapshots about 21 h apart)

| Table | 17 Nov | 18 Nov | Rate | Bytes/row (D8) |
| --- | ---: | ---: | ---: | ---: |
| AgentDecision | 7.6 GB | 8.08 GB | ~0.55 GB/day | ~1.0 KB |
| MarketObservation | 3.8 GB | 3.99 GB | ~0.22 GB/day | ~2.5 KB |
| CyclePlan | 1.1 GB | 1.19 GB | ~0.1 GB/day | ~17 KB |
| OpportunityFunnelEvent | 0.7 GB | 0.73 GB | ~0.03 GB/day | ~0.4 KB |

These are single-interval rates from rounded 17 Nov figures. The order of magnitude, about 0.8–0.9 GB a day, matches the recorded 0.75 GB a day.

## 3. Retirement (implemented, default off)

`LEGACY_CRYPTO_MODE=RETIRED` in the worker environment, then a worker restart (`apps/worker/src/legacy-retirement.ts`):

| Behaviour | RETIRED |
| --- | --- |
| Solana discovery (`fetchUniverse`) | **not called**: no new pairs observed, security-assessed or evaluated |
| New entries | `pauseNewEntries` forced true at config read in `loadPlan`, `config()` and settle. Only ever tightens; the stored config is not rewritten |
| Queued entries | PAPER: settle cancels pending ENTRY/OPERATOR buys (`ENGINE_HALTED`), the existing pause path. SANDBOX practice venue: the outbox refuses never-submitted BUYs (`PAUSE_NEW_ENTRIES`) |
| Held, pending and protected instruments | mandatory mark refresh unchanged (its own Solana pair lookup), so exits, protection, settlement and reconciliation continue. Tested: an open position under RETIRED receives its held mark without discovery and its exit SELL fills |
| Empty cycle | not an error: `CycleRun.error` stays null (so no system-error log line or equity-chart warning), and no permanent REJECT `EMPTY_UNIVERSE` decision is written each cycle |
| Visibility | the worker logs the mode once at start; an unrecognised value logs a warning |
| History, cash, HWM, daily loss, drawdown | untouched. No row is deleted or rewritten |
| Typo in the value | treated as RETIRED and reported (`issue`) |
| Reversal | set `ACTIVE` or remove the variable, then restart the worker |

**Not changed:** FX/ETF paper extras (`marketDataPaperFxIngest`, `multiMarketPaperIngest`) stay under their own config flags.

**Known gaps:**
- The API and dashboard read the stored config, so they show `pauseNewEntries: false` while the worker is retired.
  - An operator BUY submitted then gets an accepted receipt, and the worker rejects it with `PAUSE_NEW_ENTRIES`.
  - Nothing is placed, but this is confusing. Operators should know this before activation.
  - Surfacing the worker's mode to the API (heartbeat or `/api/aurum/readiness`) is a follow-up.
- A plan stored before a restart is re-checked against a fresh, paused plan (`plan-consume.ts`), so its BUYs fail admission. The reviewer inferred this from the code; it is not tested.

**Tests:**
- 7 unit tests: parsing, typo handling, tighten-only.
- 1 SANDBOX entry-block unit test.
- 4 disposable-database tests through the real StageRunner:
  - ACTIVE is unchanged;
  - RETIRED on a flat book;
  - RETIRED cancelling a queued entry with cash unchanged, then reversal to ACTIVE;
  - RETIRED with an open position: held mark refreshed and exit filled.

**Review:** `quant-safety-reviewer` gave APPROVE WITH NOTES.
- Fixed: findings 1 (SANDBOX outbox), 2 (typo never reported), 4 (retired cycles logged as errors) and 5 (exit test).
- Documented: finding 3 (API visibility) and finding 6 (demo and replay modes are unaffected).
- Results are in STATUS.md.

**Activation checklist (operator approval D3; not authorised):**
1. Fresh read-only check, immediately before activation: 0 open positions, 0 pending orders, 0 unsettled fills, 0 unresolved protection intents or recovery cases, for `primary` and every `primary:*` account.
2. Confirm that no research job or dataset depends on new Solana observations. No campaign is running (D8), and no Solana warehouse refresh is scheduled.
3. Deploy the code, set `LEGACY_CRYPTO_MODE=RETIRED` in the worker env and restart the worker only.
4. Check the first cycles: CycleRun note present, 0 Solana observations, 0 new orders, cash/HWM/drawdown unchanged, `/api/health` ok.
5. Measure for 24 h with the D14 queries and compare.

## 4. Projected growth after retirement (ESTIMATE; to be replaced by D14 measurements)

Assumptions: flat book (0 positions); FX extras on or off as today (unknown); 4,320 cycles a day at 20 s.

| Table | Now | After | Basis |
| --- | ---: | ---: | --- |
| MarketObservation | ~0.22 GB/day | ~0 (Solana) + FX extras | no discovery rows; held refresh empty on a flat book |
| AgentDecision | ~0.55 GB/day | ~0.01–0.03 GB/day | per-pair agent rows vanish; a few per-cycle rows remain |
| CyclePlan | ~0.1 GB/day | ~0.005–0.01 GB/day | an empty plan is a fraction of a 17 KB plan |
| OpportunityFunnelEvent | ~0.03 GB/day | ~0 | events are per evaluated pair |
| **Database total** | **~0.8–0.9 GB/day** | **~0.02–0.05 GB/day plus FX extras** | |

**Effect on the disk:**
- At the current rate, 44 GB free is roughly 50–55 days from the database alone, and less if dumps accumulate.
- After retirement, database growth stops being the constraint.
- The nightly dump also stops growing by about 120 MB a night. It stays at about 2 GB until data is archived.

## 5. Archive executor and destination

- **Status:** independently reviewed by TITANIUM and **rejected for deletion**; deletion is quarantined behind `DELETION_BLOCKED_PENDING_DURABLE_AUDIT`.
- **What works:** restore and verify still work and are tested.
- **What is needed:** the durable audit protocol (RetentionRun, Batch and Audit tables) is a protected schema change (TITANIUM-STORAGE-REVIEW).
- **MarketObservation:** stays executor-blocked.

**The destination must be separate storage to bring real relief:**
- Archiving to the same disk only replaces rows with their gzip copy. JSONL compresses about 5–10× (UNVERIFIED for these rows).
- A DELETE returns no space to the OS without `pg_repack` or `VACUUM FULL`. Either needs free space about the size of the table (8 GB for AgentDecision), which shrinks as the disk fills.
- So archival brings net relief only if the archive goes to a separate volume or object store, and repack runs while enough space is free.
- Recommendation: retire first (this stops growth), then fix dump retention, then build the audited archive to separate storage.

## 6. Decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| D3 | Activate `LEGACY_CRYPTO_MODE=RETIRED` after the §3 checklist | yes, after a fresh zero-obligation check and code review |
| D14 | Approve the read-only disk and growth inspection in §1 | yes, now |
| D15 | Backup dump retention policy (for example 7 daily and 4 weekly) | decide after D14 |
| D16 | Archive destination: separate volume or object store | separate storage; required for real relief |
