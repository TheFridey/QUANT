import { readFileSync } from "node:fs";

/**
 * OPERATION INTEGRITY F10: research process resource guarantees. Dependency-free on purpose (node builtins only),
 * so real-child tests can load it directly.
 *
 * Process tree: trading worker → (tick) campaign-cli work-next → (per unit) campaign-evaluator → worker thread.
 * Every parent gives its child a stdin PIPE and sets ODIN_SUPERVISOR_PIPE=1. A child that sees that pipe close
 * knows its parent is gone (exit, crash or SIGKILL alike: the OS closes the pipe) and exits at once, killing its
 * own children the same way. So cancellation, timeout or death at any level removes every descendant without
 * process groups, and works the same on Linux and Windows. Without the flag (an operator at a terminal) nothing is
 * installed, because an ignored or closed stdin would look like a dead parent.
 *
 * Memory, named accurately:
 *  - `--max-old-space-size` / `resourceLimits.maxOldGenerationSizeMb` limit the V8 HEAP (old generation) only.
 *  - Total resident memory (RSS: heap + buffers + code + thread stacks) is bounded here only by a SAMPLED watchdog
 *    (`installRssWatchdog`), which stops the process when a sample exceeds its limit. It is best effort: an
 *    allocation spike between samples can exceed it. A hard total-memory guarantee needs the OS (cgroup
 *    `memory.max`, see docs/integrity/F10-INVESTIGATION.md); `detectOsMemoryLimit` reports whether one applies.
 */
export const SUPERVISOR_PIPE_ENV = "ODIN_SUPERVISOR_PIPE";
export const EXIT_SUPERVISOR_GONE = 137;
export const EXIT_RSS_LIMIT = 138;

export function supervisorPipeRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SUPERVISOR_PIPE_ENV] === "1";
}

/** Exits (after `onGone`, e.g. killing children) when the parent's stdin pipe closes. No-op unless requested. */
export function installSupervisorLiveness(onGone: () => void = () => undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!supervisorPipeRequested(env)) return false;
  let fired = false;
  const gone = () => {
    if (fired) return;
    fired = true;
    try {
      onGone();
    } finally {
      process.stderr.write("SUPERVISOR_GONE: parent pipe closed; stopping\n");
      process.exit(EXIT_SUPERVISOR_GONE);
    }
  };
  process.stdin.on("end", gone);
  process.stdin.on("close", gone);
  process.stdin.on("error", gone);
  process.stdin.resume();
  // Watching the pipe must not keep this process alive: when its own work is done it exits normally (review H1:
  // a resumed stdin otherwise held a successful CLI open until the tick's ceiling killed it).
  (process.stdin as unknown as { unref?: () => void }).unref?.();
  return true;
}

/** Sampled total-memory (RSS) watchdog. Returns a stop function. */
export function installRssWatchdog(limitMb: number, everyMs = 200, onExceeded: (rssMb: number) => void = () => undefined): () => void {
  if (!(Number.isFinite(limitMb) && limitMb > 0)) return () => undefined;
  const timer = setInterval(() => {
    const rssMb = process.memoryUsage.rss() / 1_048_576;
    if (rssMb > limitMb) {
      try {
        onExceeded(rssMb);
      } finally {
        process.stderr.write(`RSS_LIMIT: resident memory ${rssMb.toFixed(0)} MB exceeded ${limitMb} MB (sampled watchdog)\n`);
        process.exit(EXIT_RSS_LIMIT);
      }
    }
  }, everyMs);
  return () => clearInterval(timer);
}

/** Total-memory watchdog limit for an evaluator whose V8 heap limit is `heapMb`: heap plus a declared allowance. */
export function rssLimitForHeap(heapMb: number): number {
  return Math.ceil(heapMb * 1.25 + 384);
}

export type OsMemoryLimit = { kind: "CGROUP_V2"; maxBytes: number; path: string } | { kind: "CGROUP_V2_UNLIMITED"; path: string } | { kind: "NONE_DETECTED"; reason: string };

/** Reads this process's cgroup v2 memory limit (Linux). Read-only; reports rather than assumes. */
export function detectOsMemoryLimit(read: (path: string) => string = (p) => readFileSync(p, "utf8")): OsMemoryLimit {
  if (process.platform !== "linux") return { kind: "NONE_DETECTED", reason: `platform ${process.platform} has no cgroup v2 memory controller` };
  try {
    const rel = read("/proc/self/cgroup").split("\n").find((l) => l.startsWith("0::"))?.slice(3).trim();
    if (rel === undefined) return { kind: "NONE_DETECTED", reason: "no cgroup v2 entry in /proc/self/cgroup" };
    const path = `/sys/fs/cgroup${rel === "/" ? "" : rel}/memory.max`;
    const raw = read(path).trim();
    if (raw === "max") return { kind: "CGROUP_V2_UNLIMITED", path };
    const maxBytes = Number(raw);
    return Number.isFinite(maxBytes) && maxBytes > 0 ? { kind: "CGROUP_V2", maxBytes, path } : { kind: "NONE_DETECTED", reason: `unreadable memory.max value ${raw}` };
  } catch (error) {
    return { kind: "NONE_DETECTED", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** RESEARCH_CAMPAIGN_REQUIRE_OS_ISOLATION=true refuses to run research without an OS memory limit. */
export function osIsolationRefusal(limit: OsMemoryLimit, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.RESEARCH_CAMPAIGN_REQUIRE_OS_ISOLATION !== "true") return null;
  return limit.kind === "CGROUP_V2" ? null : `REFUSED: RESEARCH_CAMPAIGN_REQUIRE_OS_ISOLATION=true but no OS memory limit applies (${limit.kind}${"reason" in limit ? `: ${limit.reason}` : ""}); run research under a cgroup with memory.max (docs/integrity/F10-INVESTIGATION.md)`;
}
