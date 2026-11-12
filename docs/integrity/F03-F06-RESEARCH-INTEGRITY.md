# F03 / F06 — research trial and holdout integrity (Phase II)

Branch `integrity/phase-ii` (off `main` `33c6a4a`). Phase I (`#75`, deployed in `2cc6627`) already made the legacy CLIs withhold every holdout and floored `--prior-trials` at the ledger. This increment closes the trial-accounting remainder and retires the legacy holdout identity.

## Architecture decision

**Research campaigns are the sole evidence-producing lifecycle (option B).** Nothing in `apps/api`, `apps/web` or `packages/evolution` reads the legacy `ResearchRun`/`ResearchTrial` registry for promotion or shadow (checked: the only reader is `programmeTrials`, which counts its rows). The four legacy CLIs stay for offline exploration and every report now carries `evidenceClass: "EXPLORATORY: not qualified evidence; holdouts withheld; use a research campaign"`.

Option A (reuse `reserveTrials`) was rejected: `RESERVED` rows require a `ResearchCampaignUnit`, and legacy trial counts depend on data-scaled grids (`gridScale`), so an exact upper bound is not known before computation. Inventing a bound would either undercount (unsafe) or inflate the programme count by guesswork.

Instead, the legacy CLIs share one rule, implemented once in `packages/evolution/src/campaign/accounting.ts` under the same advisory lock (`TRIAL_LEDGER_LOCK`) as campaign reservations:

| Step | Row (`ResearchTrialLedger`, append-only) | Effect |
| --- | --- | --- |
| `openStudy` before any computation | `LEGACY_DECLARED`, 0 trials, note `study-open:<key> …`, `priorTrials` frozen | durable record that the study started; the programme count it is deflated by cannot drift on retry |
| `closeStudy` before anything is printed | `LEGACY_DECLARED`, N trials, note `study-close:<key> …` | trials join the programme count; if this write fails the CLI throws and prints nothing |
| retry, same key | none (reuses the open; a second close is `ALREADY_CLOSED`) | idempotent; deterministic per key (CLI, dataset id, dataset `versionHash`, code version, arguments) |
| crash between open and close | unclosed open stays | `openStudies()` lists it for reconciliation; nothing was disclosed, so nothing could be selected on |
| other trials committed meanwhile | — | reported as `concurrentTrials` / `priorStale: true` in the output, never hidden |

No schema change: the existing CHECK already allows `LEGACY_DECLARED` with `trials >= 0` and a non-empty note. `research-cli` and `intelligence-cli --record` still write registry rows (counted as before); their close adds only trials that are not registry rows (intelligence base re-evaluations and ML learners). `intelligence-cli` dry runs previously counted **nothing**; they now count everything. `research-cli` and `intelligence-cli --record` refuse an already-closed key rather than duplicate registry rows. CSV and `--gecko` offline modes have no database: they remain labelled `NOT_RECORDED` / exploratory (unchanged limitation).

### Statistical justification for "close before disclose"

Selection bias arises from choosing among results that were seen. A legacy CLI prints only at the end, after the close is committed. A crash before the close therefore discloses nothing; counting the study at zero is correct, and the open row keeps the attempt visible. A campaign unit differs (its partial results are persisted and viewable), which is why campaigns reserve a bound up front.

## F06: legacy holdout identity

`holdoutAvailable` (strategy × raw `instrumentKey` × interval) had no production caller left. It is now a stub that always returns `false` and touches nothing, so an old import fails safe. The only holdout path is the campaign holdout ledger (normalised instrument, market, interval, lineage and window overlap, committed before any holdout bar is read).

## Historical "3,000" trials — reconciliation (BLOCKED on operator input; nothing declared)

Evidence:

| Source | Figure | Meaning |
| --- | --- | --- |
| `docs/genesis/EXECUTION_LEDGER.md:64` (4 Nov) | 2,454 | prior `ResearchTrial` registry rows (already counted by `programmeTrials.legacyRegistry`) |
| same, ML runs | +4 per run | ML learners, not in the registry |
| `docs/horizon/LEDGER.md:137` | 2,474 | 2,454 + ML runs, typed as `--prior-trials` |
| `docs/horizon/LEDGER.md:91` | 2,700 → ~2,900 | running total after 1h HORIZON CSV runs |
| `docs/horizon/LEDGER.md:59` | 3,000 | rounded-up running total used for daily FX/gold CSV runs |

Conclusion: **3,000 is a cumulative programme count, typed by hand, that includes the ~2,454 registry rows the ledger already counts.** The genuinely unrecorded part is the HORIZON/ML CSV-mode trials, roughly 3,000 − 2,454 ≈ 550 (rounding included). Declaring 3,000 would double-count ~2,454 trials. `docs/evidence/ADR-0001-research-campaigns.md`, `docs/evidence/HANDOVER.md` and `docs/horizon/LEDGER.md` described 3,000 as "unrecorded"; corrected in this branch (F12).

Operator questionnaire (answers decide the declaration):

1. On production, what does `SELECT count(*) FROM "ResearchTrial" WHERE "window" IN ('TRAIN','FULL_GRID')` return (read-only)? If ≈ 2,454 or more, the registry part is already counted.
2. Were any HORIZON/ML runs made in warehouse mode before `#71` (which started declaring them)? Those trials are in neither the registry nor the ledger.
3. Do you accept declaring the conservative upper bound `3,000 − <answer 1 at 6 Nov>`, rounded **up**, as one `LEGACY_DECLARED` row?

Proposed command once answered (not run): `campaign-cli declare-legacy-trials --count <N> --by <operator> --note "pre-ledger HORIZON/ML CSV trials 4–6 Nov 2026; cumulative 3,000 minus <registry> registry rows; see docs/integrity/F03-F06-RESEARCH-INTEGRITY.md"`.

## Tests

| Test | Kind | Result |
| --- | --- | --- |
| `apps/worker/src/research/study-accounting.integration.test.ts` (10) | real PostgreSQL 18.3 (disposable cluster), two PrismaClients as two processes | 10/10 pass: open counts 0 and freezes prior; close counts once; crash after open → visible unclosed study; retry reuses prior and counts once; same-key concurrent open/close → one row each; different concurrent studies → later close reports the earlier one's trials; DB outage before open → throws, no rows; DB outage after open → close throws, open stays visible; never-opened / malformed key / negative or fractional count refused; supplied prior below ledger ignored; rows immutable (append-only trigger) |
| `apps/worker/src/research/holdout-policy.test.ts` (7) | unit + source-order | 7/7: retired `holdoutAvailable` never grants and never queries (aliases `EUR_USD`/`EUR/USD`, new instruments); study key stable under key order; every warehouse CLI opens before computing, closes before its last print, prints nothing in between, carries the evidence class, no longer calls `declareLegacyTrials` |
| Mutation: close always inserts (idempotency guard removed) | rebuild + rerun | 2 integration tests fail (killed); source restored |

Not covered: an end-to-end run of each CLI against a populated warehouse (the CLIs need real datasets; source-order tests and the shared helper tests stand in). PostgreSQL 18.3 locally, not 16.
