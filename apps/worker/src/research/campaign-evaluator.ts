import { readFileSync, writeFileSync } from "node:fs";
import { isMainThread, Worker, workerData } from "node:worker_threads";
import { installNetworkBlock } from "./network-guard.js";

/**
 * Campaign evaluator process:
 *
 *   node --max-old-space-size=<MB> dist/src/research/campaign-evaluator.js <job.json> <out.json> [maxRuntimeMs] [maxMemoryMb]
 *
 * Reads one job file, evaluates it deterministically and writes one result file. It has no database and no
 * network: the supervisor loaded the bars, and the network is blocked before the job is read.
 *
 * The evaluation is synchronous CPU work, so it runs in a worker thread while this main thread keeps a timer.
 * That gives the process its own runtime limit: if the supervisor is killed, the evaluator still stops instead
 * of running on as an orphan. The supervisor's kill timer and the heap limits remain the primary limits.
 */

type Payload = { jobPath: string; outPath: string };

async function evaluate({ jobPath, outPath }: Payload): Promise<void> {
  // Installed in the thread that evaluates, before anything else is imported there.
  const guard = installNetworkBlock();
  const started = process.hrtime.bigint();
  const { evaluateUnit } = await import("@odin/evolution/campaign");
  const job = JSON.parse(readFileSync(jobPath, "utf8")) as Parameters<typeof evaluateUnit>[0];
  let payload: Record<string, unknown>;
  try {
    payload = { ok: true, evaluation: evaluateUnit(job) };
  } catch (error) {
    payload = { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  const runtimeMs = Number(process.hrtime.bigint() - started) / 1e6;
  writeFileSync(outPath, JSON.stringify({ ...payload, runtimeMs, peakRssMb: +(process.resourceUsage().maxRSS / 1024).toFixed(1), networkAttemptsBlocked: guard.blocked() }));
}

function supervise(): void {
  const [jobPath, outPath, runtimeArg, memoryArg] = process.argv.slice(2);
  if (!jobPath || !outPath) {
    console.error("usage: campaign-evaluator <job.json> <out.json> [maxRuntimeMs] [maxMemoryMb]");
    process.exit(2);
  }
  installNetworkBlock();
  const maxRuntimeMs = Number(runtimeArg);
  const maxMemoryMb = Number(memoryArg);
  const worker = new Worker(__filename, { workerData: { jobPath, outPath } satisfies Payload, ...(Number.isFinite(maxMemoryMb) && maxMemoryMb > 0 ? { resourceLimits: { maxOldGenerationSizeMb: maxMemoryMb } } : {}) });
  // A little after the supervisor's own timer, so the supervisor's clearer RUNTIME_LIMIT wins when it is alive.
  const timer = Number.isFinite(maxRuntimeMs) && maxRuntimeMs > 0 ? setTimeout(() => {
    console.error(`RUNTIME_LIMIT: evaluation exceeded ${maxRuntimeMs} ms`);
    process.exit(124);
  }, maxRuntimeMs + 5_000) : null;
  worker.on("error", (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
  worker.on("exit", (code) => {
    if (timer) clearTimeout(timer);
    process.exit(code);
  });
}

if (isMainThread) supervise();
else {
  evaluate(workerData as Payload).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
