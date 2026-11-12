import { spawn } from "node:child_process";
import { constants, setPriority } from "node:os";
import { resolve } from "node:path";
import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable, OnModuleInit } from "@nestjs/common";
import { Queue } from "bullmq";
import { workerLog } from "./logger.js";
import { SUPERVISOR_PIPE_ENV } from "./research/process-guards.js";

/**
 * OPERATION EVIDENCE campaign job. Disabled by default: nothing is scheduled, and the processor returns at
 * once, unless RESEARCH_CAMPAIGN_WORKER_ENABLED is exactly "true".
 *
 * Research evaluation is CPU-bound for seconds to minutes, so it must never run in this process: the trading
 * pipeline shares its event loop. Each tick therefore only starts `campaign-cli work-next` as a separate
 * process and waits for it without blocking. That process claims units under database leases and runs each
 * evaluation in its own child with the campaign's memory and runtime limits. If this worker restarts, the
 * leases expire and the next tick resumes the run. The job writes research tables only.
 */
export const RESEARCH_CAMPAIGN_QUEUE = "odin.research-campaign";
export const RESEARCH_CAMPAIGN_FLAG = "RESEARCH_CAMPAIGN_WORKER_ENABLED";

/**
 * Ceiling on one tick: the longest a unit may run (the specification's hard limit of 60 minutes) for each unit
 * the tick may handle, plus a margin. The CLI stops itself well before this in normal operation; an evaluator
 * also carries its own runtime limit, so nothing started here can outlive it for long.
 */
const UNIT_CEILING_MS = 3_600_000;
const TICK_MARGIN_MS = 300_000;

/** Only what the campaign CLI needs. The worker's other secrets (provider keys, JWT secret) are not passed on. */
const CLI_ENV_KEYS = ["PATH", "Path", "NODE_ENV", "DATABASE_URL", "GIT_COMMIT", "SystemRoot", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"];

function lowerPriority(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    setPriority(pid, constants.priority.PRIORITY_LOW);
  } catch {
    // Best effort: research must yield to trading, but a host that refuses the call still runs it bounded.
  }
}

export function campaignWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RESEARCH_CAMPAIGN_FLAG] === "true";
}

export function campaignEveryMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.RESEARCH_CAMPAIGN_TICK_MS ?? 60_000);
  return Number.isFinite(parsed) && parsed >= 30_000 ? Math.floor(parsed) : 60_000;
}

/** Bounded units per tick (1..5), so one tick cannot monopolise the host. */
export function campaignMaxUnits(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.RESEARCH_CAMPAIGN_MAX_UNITS ?? 1);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 5 ? parsed : 1;
}

export type TickResult = { status: "DISABLED" } | { status: "RAN"; exitCode: number | null; timedOut: boolean; output: string };

/** Starts the campaign CLI as a separate, low-priority process and resolves when it exits. */
/** `signal` cancels the tick (for example on worker shutdown): the CLI is killed and, through its pipe, its evaluator. */
export function runCampaignTick(env: NodeJS.ProcessEnv = process.env, options: { cliPath?: string; ceilingMs?: number; execArgv?: string[]; signal?: AbortSignal } = {}): Promise<TickResult> {
  if (!campaignWorkerEnabled(env)) return Promise.resolve({ status: "DISABLED" });
  const cli = options.cliPath ?? resolve(__dirname, "research/campaign-cli.js");
  return new Promise((done) => {
    const units = campaignMaxUnits(env);
    const childEnv = { ...Object.fromEntries(CLI_ENV_KEYS.filter((k) => env[k] !== undefined).map((k) => [k, env[k]])), RESEARCH_CAMPAIGN_REQUIRE_OS_ISOLATION: env.RESEARCH_CAMPAIGN_REQUIRE_OS_ISOLATION, [SUPERVISOR_PIPE_ENV]: "1" };
    // F10: stdin is a pipe held open for the child's lifetime. If this worker dies, the OS closes it and the CLI
    // (and through the same mechanism its evaluator) stops, instead of running on unsupervised.
    const child = spawn(process.execPath, [...(options.execArgv ?? []), cli, "work-next", "--max-units", String(units)], { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
    child.stdin.on("error", () => undefined);
    lowerPriority(child.pid);
    let output = "";
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.ceilingMs ?? units * UNIT_CEILING_MS + TICK_MARGIN_MS);
    const onAbort = () => child.kill("SIGKILL");
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      done({ status: "RAN", exitCode: null, timedOut, output: error.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      done({ status: "RAN", exitCode: code, timedOut, output });
    });
  });
}

@Injectable()
export class ResearchCampaignScheduler implements OnModuleInit {
  constructor(@InjectQueue(RESEARCH_CAMPAIGN_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    for (const job of await this.queue.getRepeatableJobs()) await this.queue.removeRepeatableByKey(job.key);
    if (!campaignWorkerEnabled()) {
      workerLog.info(`research campaign job disabled (${RESEARCH_CAMPAIGN_FLAG} is not true); nothing scheduled`);
      return;
    }
    const everyMs = campaignEveryMs();
    // No BullMQ retries: database leases and the next tick are the retry.
    await this.queue.add("research-campaign-tick", {}, { repeat: { every: everyMs }, attempts: 1, removeOnComplete: 50, removeOnFail: 50 });
    workerLog.info({ everyMs, maxUnits: campaignMaxUnits() }, "research campaign tick scheduled");
  }
}

@Processor(RESEARCH_CAMPAIGN_QUEUE, { concurrency: 1 })
export class ResearchCampaignProcessor extends WorkerHost {
  async process(): Promise<void> {
    const result = await runCampaignTick();
    if (result.status !== "RAN") return;
    const log = result.exitCode === 0 ? workerLog.info.bind(workerLog) : workerLog.warn.bind(workerLog);
    log({ exitCode: result.exitCode, timedOut: result.timedOut, output: result.output.slice(-1500) }, "research campaign tick");
  }
}
