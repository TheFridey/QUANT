# D14: read-only production storage inspection, 18 November 2026

Operator approval: "Approve D14" (18 Nov 2026), for the read-only disk, backup and growth inspection in [CATALYST-STORAGE-AND-RETIREMENT.md](CATALYST-STORAGE-AND-RETIREMENT.md) §1. Nothing was written, deleted, restarted or changed.

## How it ran

- Over `ssh scalesmiths`:
  - `df`;
  - `du -xsh` under `nice -n 15 ionice -c3`;
  - backup directory listing;
  - read of `/srv/quant/backup-db.sh`, with lines mentioning credentials filtered out (`database.env` was not read);
  - `systemctl list-timers`;
  - `journalctl --disk-usage`.
- SQL: [`evidence/d14-production-readonly-20261118.sql`](evidence/d14-production-readonly-20261118.sql).
  - One `REPEATABLE READ READ ONLY` transaction, `statement_timeout 60s`; the server reported `read_only = on` and the transaction committed at 13:04:35 UTC.
  - Plus a read-only `pg_stats` / `pg_stat_user_tables` lookup.
- Output holds aggregates and paths only. No credential or customer data was printed.

## Disk (VERIFIED_PRODUCTION)

`/` is 146 GB with 102 GB used and 44 GB free (71%).

| Path | Size | Owner |
| --- | ---: | --- |
| `/var/www/scalesmiths` | **39 GB** | another site on this VPS, not QUANT |
| `/srv/quant/backups` | **28 GB** | QUANT: 26 dumps plus 2 small directories |
| `/var/lib/postgresql` | 15 GB | QUANT database 14 GB; WAL 81 MB |
| `/var/log` | 3.4 GB | `journal` 2.9 GB |
| `/var/www/vf` | 2.6 GB | another site |
| `/root` | 2.5 GB | not inspected further |
| `/srv/quant/app` | 977 MB | checkout and `node_modules` |
| `/srv/quant/releases` | 693 MB | build snapshots |

The PostgreSQL server is **14.24** (Ubuntu 22.04 package). CI and local tests use 16. That difference is not new, but it is now recorded.

## Backups (VERIFIED_PRODUCTION)

- **Schedule and pruning:** `quant-backup.timer` runs `/srv/quant/backup-db.sh` at 03:15 daily. The script runs `pg_dump --format=custom`, checks the dump with `pg_restore --list`, renames it into place atomically, and **deletes `quant-*.dump` older than 14 days** (`-mtime +14`). Pruning works: the oldest kept dump is from 3 Nov.
- **Pre-deploy dumps** use the same name pattern, so they are pruned the same way. Eight of the 26 are pre-deploy or manual dumps taken inside the window.
- **Dump size** has grown from 0.35 GB (3 Nov) to 2.03 GB (18 Nov). The last two nightly dumps grew **0.12 GB a night**, tracking the database.

## Write rates, last 24 hours (VERIFIED_PRODUCTION)

| Table | Rows / 24 h | What they are | Bytes/row | ≈ GB/day |
| --- | ---: | --- | ---: | ---: |
| MarketObservation | 103,608 | **100% `dexscreener`, MARKET_DATA_PAPER**: Solana discovery only. FX and multi-market ingest are off | ~2.3 KB | ~0.24 |
| AgentDecision | 526,552 | 522,236 per-pair rows (PULSE, EXECUTOR, AEGIS HOLD; ATLAS HOLD/REJECT; SENTINEL REJECT/PASS) + 4,316 per-cycle rows | ~0.93 KB | ~0.49 |
| CyclePlan | 4,316 | one per cycle; 63 MB of plan JSON | ~15 KB | ~0.07 |
| OpportunityFunnelEvent | 114,914 | per evaluated pair | ~0.41 KB | ~0.05 |
| CycleRun | 4,317 | one per 20 s cycle | small | ~0.003 |
| **Database total** | | | | **~0.85** |

The engine is `RUNNING`, with `pauseNewEntries` false and `universeLimit` 24. There are 0 open positions and 0 orders in PENDING, UNKNOWN, PRE_SUBMIT or SUBMITTED. This is not the D3 activation check, which must be repeated immediately before activation.

## Finding: the proposed retention policy would archive almost nothing

- The policy ages out AgentDecision rows only when `decision = 'NO_INTENT'`. All other values are preserved for ever.
- Production holds **no NO_INTENT rows**:
  - it is absent from the last 24 hours;
  - `pg_stats` for the whole table (9.07 M rows, analysed 17 Nov) gives HOLD 76.6%, REJECT 18.4%, PASS 5.0%, ACT 0.02%.
- So the policy would keep essentially all 8 GB of AgentDecision. The STORAGE-PLAN statement "about 8,640 NO_INTENT decisions every 2 hours" is wrong for the current code.
- **Not changed in code.** Deciding which routine decisions may age out is an operator policy choice (D1). The options are:
  - (a) any decision in a cycle with no order, intent or equity evidence, keeping ACT everywhere;
  - (b) only HOLD and PASS, keeping REJECT as risk-refusal history;
  - (c) keep everything and rely on retirement to stop growth.
- With (a), the table would shrink by nearly all rows older than 30 days. Space only comes back after a repack.

## Projection (DERIVED from the figures above)

**Without retirement:**
- The database grows about 0.85 GB a day.
- The backup directory converges on 14 × the dump size, and the dump grows about 0.12 GB a night. So backups grow about 14 × 0.12 ≈ 1.7 GB a day, plus pre-deploy dumps.
- **Total: about 2.5 GB of disk a day. 44 GB free runs out in about 17–18 days (around 5–6 December 2026),** sooner with deploy dumps.

**With retirement:**
- About 99% of the per-pair writes stop: all of MarketObservation, about 522 k AgentDecision rows, the funnel events, and most CyclePlan bytes.
- The remainder is about 4,300 per-cycle decisions and 4,300 CycleRun and CyclePlan rows a day, under about 0.02 GB.
- The dump stops growing. The backup directory then levels off at about 14 × 2.05 ≈ 29–31 GB, about 1–3 GB above today, as the small early dumps roll off.
- **Disk stabilises at roughly 40–42 GB free.**

**Other levers, in order of size:**

| Lever | Space | Decision |
| --- | --- | --- |
| Backup window from 14 to 7 days (operator) | about −14 GB once, and halves backup growth | D15 |
| Moving backups off-host (also better disaster recovery) | about −28 GB | D15/D16 |
| `/var/www/scalesmiths` (39 GB) | outside QUANT | operator, separately |
| journald cap, for example 500 MB | about −2.4 GB | operator |
| Archive plus repack of AgentDecision under option (a), to separate storage | up to about −7 GB of database, and dumps shrink with it | D1 + protected audit + D16 |

**Recommendation:**
1. Activate retirement (D3) soon. It is the only lever that stops growth, and the disk has about 2.5 weeks left.
2. Shorten the backup window to 7 days or move dumps off-host (D15).
3. Decide the AgentDecision policy (D1 option) before any archival work.
