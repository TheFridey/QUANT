# Project ASCEND

The programme to turn QUANT from a working paper-trading engine into an evidence-driven research platform. This folder is its durable record, so any session or agent can pick it up. The repository rules in `AGENTS.md`, `CLAUDE.md` and `docs/STATUS.md` override anything here.

QUANT stays PAPER-only. ASCEND never changes `EXECUTION_MODE`, the live-money gate, wallet/signing restrictions or risk limits without explicit operator approval, and never self-unlocks protected paths.

| File | Purpose |
| --- | --- |
| [`STATUS.md`](STATUS.md) | Workstream status with evidence labels; the first thing to read when resuming |
| [`ascend-00-safety-autopsy.md`](ascend-00-safety-autopsy.md) | Priority-zero findings: daily-loss lockout, resume, rejected sells, trade autopsy |
| [`research-registry.md`](research-registry.md) | Source registry. Papers are listed only after they have been read |
| `experiments/` | One record per research experiment, failures included (created when the first experiment is registered) |

## Workstreams and dependencies

```
ASCEND-00 Safety + autopsy ──┬─> ASCEND-01 Historical data ─┬─> ASCEND-02 Research engine ─> ASCEND-03 Validation ─┬─> ASCEND-04 Regimes ─> ASCEND-05 ML
                             │                              │                                                     ├─> ASCEND-07 Portfolio
                             └─> ASCEND-06 Execution costs <┘                                                     └─> ASCEND-08 ORACLE research loop
ASCEND-09 Trade feedback  (needs 00 autopsy + 05 models)
ASCEND-10 Operator views  (follows each workstream; no fake metrics)
ASCEND-11 Production validation (per milestone)
```

ASCEND-03 (walk-forward, purging, PSR/DSR, trial tracking) comes before any strategy is called validated. ASCEND-06 can start straight after 00, because the forensic autopsy needs cost attribution anyway.

## Per-workstream contract

1. Inspect the existing implementation and record the root findings here.
2. Specify the tests before major changes.
3. Make the smallest correct extension in the existing architecture.
4. Run the targeted tests, then `pnpm test`, `pnpm typecheck` and `pnpm lint`.
5. Run the `quant-safety-reviewer` agent for any high-risk path (see `AGENTS.md`).
6. Open a focused PR, verify CI, and merge or deploy only with operator authorisation.
7. Update [`STATUS.md`](STATUS.md) with evidence labels. Never mark a workstream done because its interface exists.

## Evidence labels

`IMPLEMENTED`, `VERIFIED_UNIT`, `VERIFIED_INTEGRATION`, `VERIFIED_HISTORICAL`, `VERIFIED_OUT_OF_SAMPLE`, `VERIFIED_SHADOW`, `VERIFIED_AUTONOMOUS_PAPER`, `VERIFIED_EXTERNAL_PAPER`, `INSUFFICIENT_EVIDENCE`, `BLOCKED_EXTERNAL`, `DEFERRED`, `FAILED`. One category is never substituted for another. Backtest, out-of-sample, shadow, autonomous paper and external paper returns are always reported separately.
