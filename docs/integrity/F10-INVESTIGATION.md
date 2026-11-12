# F10 — research process resource guarantees

## Recovered specification

The original audit text of F10 was absent from the repository. It was recovered verbatim from the Phase I session transcript: "F10 — RESEARCH PROCESS RESOURCE GUARANTEES, MEDIUM".

**Relevant files:** `apps/worker/src/campaign-job.ts`, `apps/worker/src/research/campaign-runner.ts`, `apps/worker/src/research/campaign-evaluator.ts`, deployment and runbook guidance, and real-child integration tests.

**Observed limitations:**

- V8 old-space limits are not total process RSS limits.
- Loading, preflight and serialisation happen in the supervisor, outside the evaluator budget.
- Killing the CLI may leave its evaluator alive until the evaluator's own runtime timer fires.

**Required results:**

- Name heap limits and total-memory limits accurately.
- Bound supervisor data loading and serialisation.
- Clean up descendants on cancellation, timeout and supervisor death.
- Provide a supported OS-level isolation recipe, with descendants inside the boundary.
- Keep research CPU work off the trading event loop.
- Do not rely on JavaScript network monkey-patching as an adversarial sandbox.
- Report or refuse unsupported guarantees.

**Verification required:** real child processes, and no production load or exhaustion testing.

## Findings at `main` `33c6a4a`

| Claim | Status before | Evidence |
| --- | --- | --- |
| Heap ≠ RSS | **Confirmed**. `--max-old-space-size` and `resourceLimits.maxOldGenerationSizeMb` were described as the "memory limit". | Real-process test: with `--max-old-space-size=64`, a process allocates 300 MB of Buffers and exits normally. |
| Orphaned evaluator | **Confirmed by reading**. The evaluator was spawned with `stdin: "ignore"` and stopped only via the supervisor's kill timer or its own timer at `maxRuntimeMs + 5 s` (up to about 60 minutes). | `campaign-runner.ts:56`, `campaign-evaluator.ts:47` |
| Supervisor loading unbounded | **Partly confirmed**. Warehouse reads were bounded (`take: maxBarsPerDataset + 1`). FILE datasets were read whole with `readFileSync`, with no size bound. Serialisation is bounded through the bar count. | `campaign-data.ts` |
| Research on the trading loop | **Not a defect**. The tick spawns `campaign-cli` as a separate low-priority process. | the existing test, plus a new event-loop lag test |
| Network guard | **Accident guard only**. It patches `net`/`fetch` in-process. | now documented as not a sandbox; generated code uses the separate evolution sandbox |

## Remediation

- **`apps/worker/src/research/process-guards.ts`** (new, dependency-free):
  - `installSupervisorLiveness`: a child started with a stdin **pipe** and `ODIN_SUPERVISOR_PIPE=1` exits with code 137 when the pipe closes. The OS closes it on any parent exit, crash or SIGKILL.
  - `installRssWatchdog`: a sampled total-memory stop, exit code 138.
  - `rssLimitForHeap`: heap × 1.25 + 384 MB.
  - `detectOsMemoryLimit`: reads cgroup v2 `memory.max`, read-only.
  - `osIsolationRefusal`: refuses when `RESEARCH_CAMPAIGN_REQUIRE_OS_ISOLATION=true` and no limit applies.
- **Process tree:** each link holds a pipe to its child (tick → `campaign-cli` → `campaign-evaluator`) and each child watches it.
  - When the tick times out, it SIGKILLs the CLI. The CLI's pipe closes and the evaluator exits.
  - When the worker dies, the CLI exits, then the evaluator does.
  - Database leases expire, and the next tick resumes the unit (existing lease behaviour).
  - Without the flag (an operator at a terminal) nothing is installed.
- **Evaluator:**
  - takes `maxHeapMb` (V8) and `maxRssMb` (watchdog) arguments;
  - the runner maps exit code 138 to "total-memory watchdog" and 137 to KILLED;
  - error messages name "V8 heap limit" and "RSS watchdog" separately;
  - `makeChildProcessEvaluator(path)` makes the contract testable with real children.
- **CLI:**
  - installs liveness at start;
  - `work-next` reports `isolation: { osMemoryLimit, heapLimit, rssWatchdog }`;
  - with `RESEARCH_CAMPAIGN_REQUIRE_OS_ISOLATION=true` it refuses to run unless a cgroup v2 limit applies;
  - the tick passes that variable through.
- **FILE datasets:** refused before reading above `maxBarsPerDataset × 256` bytes, and after parsing above `maxBarsPerDataset` bars.

## Guarantees, named accurately

| Limit | Kind | Enforced by | Hard? |
| --- | --- | --- | --- |
| `limits.maxMemoryMbPerUnit` | V8 old-generation heap of the evaluator | `--max-old-space-size` and the worker `resourceLimits` | yes, for the JS heap only |
| `rssLimitForHeap(heap)` | total resident memory of the evaluator | sampled watchdog every 200 ms | **no**: best effort, since a spike between samples can exceed it |
| cgroup `memory.max` | total memory of every process in the unit | Linux kernel | **yes**, when deployed as below |
| `limits.maxRuntimeMsPerUnit` | wall time | supervisor kill timer, plus the evaluator's own timer | yes (SIGKILL) |
| Parent death | descendant lifetime | stdin-pipe liveness | yes on Linux and Windows, except a frozen parent that holds the pipe open (covered by the runtime timers) |
| Supervisor loading | bars and bytes read | `maxBarsPerDataset`, file-size bound | yes |

## Supported deployment recipe (Linux, OS-level isolation)

Run research as its own systemd service, so that every descendant stays in the service's cgroup. Turn the in-worker tick off. Proposed only: **not applied to the VPS**, which needs operator approval.

```ini
# /etc/systemd/system/odin-research.service
[Unit]
Description=ODIN research campaign units (PAPER research only)
After=postgresql.service

[Service]
Type=oneshot
User=quant
WorkingDirectory=/srv/quant/current
EnvironmentFile=/srv/quant/shared/research.env
Environment=RESEARCH_CAMPAIGN_REQUIRE_OS_ISOLATION=true
ExecStart=/usr/bin/node apps/worker/dist/src/research/campaign-cli.js work-next --max-units 1
MemoryMax=10G
MemorySwapMax=0
CPUQuota=150%
Nice=10
TimeoutStartSec=65min
KillMode=control-group
```

```ini
# /etc/systemd/system/odin-research.timer
[Timer]
OnBootSec=5min
OnUnitInactiveSec=1min
[Install]
WantedBy=timers.target
```

**Settings:**

- `research.env` holds only `DATABASE_URL`, `NODE_ENV` and `GIT_COMMIT`. No provider keys and no JWT secret.
- Set `RESEARCH_CAMPAIGN_WORKER_ENABLED=false` (the default) for the trading worker.
- `MemoryMax` must exceed the largest declared `maxMemoryMbPerUnit` plus the supervisor's dataset (up to about 200,000 bars).
- `KillMode=control-group` kills every descendant when the service stops.

**Read-only checks for the operator before relying on it:**

```bash
systemctl show odin-research -p MemoryMax -p ControlGroup
```

```bash
cat /sys/fs/cgroup/system.slice/odin-research.service/memory.max
```

The `work-next` output field `isolation.osMemoryLimit.kind` must read `CGROUP_V2`.

**VPS state is not verified.** This session did not inspect the production host. Whether pm2 or systemd already applies cgroup limits there is unknown. The worker tick path inherits whatever cgroup pm2 runs in.

## Tests (`apps/worker/src/research/process-isolation.test.ts`, real child processes)

| Scenario | Result |
| --- | --- |
| Supervisor death: the parent's pipe closes, so the child exits promptly with 137 | pass |
| SIGKILL the middle (CLI) process: the leaf (evaluator) exits | pass |
| Tick timeout SIGKILLs the CLI: the whole tree is gone | pass |
| No flag and stdin ignored: the process is not stopped | pass |
| Heap limit 64 MB still lets 300 MB of Buffers through; a 200 MB RSS watchdog stops the same process with 138 | pass |
| Evaluator normal completion; arguments (heap, RSS limit, flag, `--max-old-space-size`) | pass |
| Runtime timeout gives `RUNTIME_LIMIT`; cancellation gives `KILLED`; watchdog gives a "total-memory watchdog" error | pass |
| Event-loop lag of the "worker" while a 3 s CPU burn runs in the tick child: under 250 ms | pass |
| cgroup detection, and refusal when required | pass |
| Source wiring (evaluator, CLI, runner, tick) | pass |

All 13 pass, plus the existing `campaign-guards.test.ts`, 20 in total.

**Mutation (liveness disabled):** only the pipe-close test failed on Windows. On Windows, libuv assigns spawned children to a kill-on-close job object, so a killed parent's children die anyway, and the two SIGKILL tests pass even without the guard there. On Linux (CI, VPS) no such job object exists, so the guard is what removes descendants. **The Linux behaviour of those two tests must be confirmed by the CI run.**

Lease expiry and recovery are covered by the existing `campaign.integration.test.ts` and are unchanged.

## Limitations

- The RSS watchdog is sampled and soft; only the cgroup gives a hard total-memory bound.
- A supervisor that hangs while alive keeps its pipe open. The runtime timers (supervisor, then the evaluator's own at +5 s) bound this case.
- The FILE bound of 256 bytes per row is a declared assumption.
