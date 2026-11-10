import { readFileSync, writeFileSync } from "node:fs";
import { installNetworkBlock } from "./network-guard.js";

/**
 * Campaign evaluator child process:
 *
 *   node --max-old-space-size=<MB> dist/src/research/campaign-evaluator.js <job.json> <out.json>
 *
 * Reads one job file, evaluates it deterministically and writes one result file. It has no database and no
 * network: the supervisor loaded the bars, and the network is blocked before the job is read. The supervisor
 * enforces the runtime limit by killing this process and the memory limit through the V8 heap flag.
 */
const guard = installNetworkBlock();

async function main(): Promise<void> {
  const [jobPath, outPath] = process.argv.slice(2);
  if (!jobPath || !outPath) throw new Error("usage: campaign-evaluator <job.json> <out.json>");
  const started = process.hrtime.bigint();
  // Loaded after the block is installed, so nothing imported here can open a connection either.
  const { evaluateUnit } = await import("@odin/evolution/campaign");
  const job = JSON.parse(readFileSync(jobPath, "utf8")) as Parameters<typeof evaluateUnit>[0];
  let payload: Record<string, unknown>;
  try {
    const evaluation = evaluateUnit(job);
    payload = { ok: true, evaluation };
  } catch (error) {
    payload = { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  const runtimeMs = Number(process.hrtime.bigint() - started) / 1e6;
  writeFileSync(outPath, JSON.stringify({ ...payload, runtimeMs, peakRssMb: +(process.resourceUsage().maxRSS / 1024).toFixed(1), networkAttemptsBlocked: guard.blocked() }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
