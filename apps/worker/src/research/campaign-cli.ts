import "../load-env.js";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import {
  authorizeHoldout,
  barsToCsv,
  cancelRun,
  createCampaign,
  declareLegacyTrials,
  planCampaign,
  preflightDataset,
  programmeTrials,
  registerCampaignModel,
  runDetail,
  startProspectiveObservation,
  startRun,
  syntheticFxBreakoutBars,
  syntheticVolumeSpikeBars,
} from "@odin/evolution/campaign";
import { PrismaClient } from "@odin/shared/db";
import { loadRawBars } from "./campaign-data.js";
import { currentCodeVersion, evaluateHoldout, workRun } from "./campaign-runner.js";
import { detectOsMemoryLimit, installSupervisorLiveness, osIsolationRefusal } from "./process-guards.js";

/**
 * OPERATION EVIDENCE research campaigns (research only; never touches the trading path):
 *
 *   node dist/src/research/campaign-cli.js <command> ...
 *
 *   plan <spec.json> [--preflight]            dry run: validate, list units and trial bounds; nothing is written
 *   create <spec.json> --by NAME              register the declaration (same declaration = same campaign)
 *   start <campaignId> --by NAME [--rerun --reason TEXT]
 *   work <runId> [--max-units N]              execute pending units (resumable; safe to run again after a crash)
 *   work-next [--max-units N]                 execute units of the oldest unfinished run (used by the worker job)
 *   status <runId>
 *   cancel <runId> --by NAME
 *   authorize-holdout <unitId> --operator NAME [--ttl-hours N] [--note TEXT]
 *   evaluate-holdout <unitId>                 reads the holdout once; needs a current authorisation
 *   register-model <unitId> --by NAME --instrument-key KEY[,KEY] --max-staleness-days N --observe-signals N
 *   observe <modelVersionId> --operator NAME --reason TEXT    start prospective (shadow) observation
 *   trials                                    programme-wide trial count
 *   declare-legacy-trials --count N --by NAME --note TEXT
 *   synthetic-fixture <fx-breakout|volume-spike-4h> <out.csv>   write a labelled synthetic dataset
 *
 * Holdouts are withheld unless an operator authorises one read for one frozen result. No command changes
 * engine configuration, risk limits, strategy instances or promotion state, and none submits an order.
 */

type Flags = { _: string[]; [k: string]: string | boolean | string[] };

function parse(argv: string[]): Flags {
  const out: Flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i += 1;
    }
  }
  return out;
}

const need = (flags: Flags, name: string): string => {
  const v = flags[name];
  if (typeof v !== "string" || !v.trim()) throw new Error(`--${name} is required`);
  return v.trim();
};
const arg = (flags: Flags, index: number, what: string): string => {
  const v = flags._[index];
  if (!v) throw new Error(`${what} is required`);
  return v;
};
const print = (value: unknown) => console.log(JSON.stringify(value, null, 1));

async function main(): Promise<void> {
  // F10: when started by the worker tick, exit (and so stop any evaluator, which watches this process the same
  // way) as soon as the tick's pipe closes. Database leases expire and the next tick resumes the unit.
  installSupervisorLiveness();
  const [command, ...rest] = process.argv.slice(2);
  const flags = parse(rest);
  const repoRoot = resolve(__dirname, "../../../../..");
  const owner = `${hostname()}:${process.pid}`;

  if (command === "synthetic-fixture") {
    const kind = arg(flags, 0, "fixture kind");
    const bars = kind === "fx-breakout" ? syntheticFxBreakoutBars({ start: "2024-06-02T22:00:00Z", bars: 4000, seed: 42, plant: { every: 30, jump: 8, drift: 1.5, len: 12 } }) : kind === "volume-spike-4h" ? syntheticVolumeSpikeBars({ start: "2020-01-01T00:00:00Z", bars: 7000, seed: 31, barMs: 14_400_000, boostBars: 6 }) : null;
    if (!bars) throw new Error("fixture kind must be fx-breakout or volume-spike-4h");
    writeFileSync(arg(flags, 1, "output path"), barsToCsv(bars));
    return print({ synthetic: true, kind, bars: bars.length, note: "Constructed series with a planted edge. Not market data; a result on it is not evidence of an edge." });
  }
  if (command === "plan" && !flags.preflight) {
    const plan = planCampaign(JSON.parse(readFileSync(arg(flags, 0, "spec path"), "utf8")));
    return print({ dryRun: true, written: "nothing", name: plan.spec.name, synthetic: plan.spec.synthetic, specHash: plan.specHash, limits: plan.spec.limits, holdoutPolicy: plan.spec.holdoutPolicy, plannedTrialsUpperBound: plan.plannedTrials, units: plan.units.map((u) => ({ seq: u.seq, dataset: u.datasetKey, hypothesis: u.hypothesisId, plannedTrials: u.plannedTrials, lineage: u.lineageKey, searchSpace: u.searchSpace })) });
  }

  const prisma = new PrismaClient();
  try {
    const codeVersion = currentCodeVersion(process.env, repoRoot);
    const deps = { owner, baseDir: process.cwd(), codeVersion, log: (message: string) => console.error(message) };
    switch (command) {
      case "plan": {
        const specPath = arg(flags, 0, "spec path");
        const plan = planCampaign(JSON.parse(readFileSync(specPath, "utf8")));
        const datasets = [];
        for (const d of plan.spec.datasets) {
          try {
            const pre = preflightDataset(d, await loadRawBars(prisma, d, dirname(resolve(specPath))));
            datasets.push({ key: d.key, ok: pre.ok, bars: pre.identity.bars, firstT: pre.identity.firstT, lastT: pre.identity.lastT, contentHash: pre.identity.contentHash, cleaning: pre.identity.cleaning, reasons: pre.ok ? [] : pre.reasons });
          } catch (error) {
            datasets.push({ key: d.key, ok: false, reasons: [error instanceof Error ? error.message : String(error)] });
          }
        }
        return print({ dryRun: true, written: "nothing", specHash: plan.specHash, plannedTrialsUpperBound: plan.plannedTrials, programmeTrials: await programmeTrials(prisma), datasets, units: plan.units.length });
      }
      case "create": {
        const specPath = arg(flags, 0, "spec path");
        const { status, campaign, plan } = await createCampaign(prisma, JSON.parse(readFileSync(specPath, "utf8")), need(flags, "by"));
        return print({ status, campaignId: campaign.id, specHash: campaign.specHash, synthetic: campaign.synthetic, units: plan.units.length, plannedTrialsUpperBound: plan.plannedTrials });
      }
      case "start": {
        if (!codeVersion) throw new Error("CODE_VERSION_REQUIRED: the working tree has uncommitted changes or is not a git checkout; commit first or set GIT_COMMIT");
        const { status, run } = await startRun(prisma, { campaignId: arg(flags, 0, "campaignId"), requestedBy: need(flags, "by"), codeVersion, rerun: flags.rerun === true, reason: typeof flags.reason === "string" ? flags.reason : undefined });
        return print({ status, runId: run.id, runNumber: run.runNumber, codeVersion: run.codeVersion, reason: run.reason });
      }
      case "work":
      case "work-next": {
        let runId = flags._[0];
        if (command === "work-next") {
          const next = await prisma.researchCampaignRunState.findFirst({ where: { state: { in: ["QUEUED", "RUNNING"] }, run: codeVersion ? { codeVersion } : undefined }, orderBy: { run: { createdAt: "asc" } }, select: { runId: true } });
          if (!next) return print({ status: "IDLE", note: "no unfinished run is pinned to this code version" });
          runId = next.runId;
        }
        if (!runId) throw new Error("runId is required");
        // F10: report (and, when required, refuse) the OS-level memory boundary research runs inside.
        const osLimit = detectOsMemoryLimit();
        const refusal = osIsolationRefusal(osLimit);
        if (refusal) throw new Error(refusal);
        // FILE datasets resolve against the directory the command is run from.
        const out = await workRun(prisma, runId, deps, { maxUnits: typeof flags["max-units"] === "string" ? Number(flags["max-units"]) : undefined });
        const state = await prisma.researchCampaignRunState.findUniqueOrThrow({ where: { runId } });
        return print({ runId, state: state.state, stopped: out.stopped, handled: out.handled, isolation: { osMemoryLimit: osLimit, heapLimit: "per unit: limits.maxMemoryMbPerUnit (V8 old space only)", rssWatchdog: "per unit: sampled, heap × 1.25 + 384 MB" } });
      }
      case "status": {
        const detail = await runDetail(prisma, arg(flags, 0, "runId"));
        if (!detail) throw new Error("run not found");
        return print({ campaign: detail.campaign.name, synthetic: detail.campaign.synthetic, run: detail.run, progress: detail.progress, programmeTrials: detail.programmeTrials, units: detail.units.map((u) => ({ id: u.id, seq: u.seq, dataset: u.datasetKey, hypothesis: u.hypothesisId, state: u.state, attempts: u.attempts, verdict: u.holdout?.verdict ?? u.walkForward?.verdict ?? null, stage: u.stage.stage, status: u.stage.status, why: u.stage.why, missing: u.stage.missing, next: u.stage.nextSteps, trials: u.trials, model: u.model, prospective: u.prospective && { resolved: u.prospective.resolved, effectiveOutcomes: u.prospective.effectiveOutcomes, sufficient: u.prospective.sufficient, missing: u.prospective.missing } })) });
      }
      case "cancel":
        return print(await cancelRun(prisma, { runId: arg(flags, 0, "runId"), actor: need(flags, "by"), now: new Date() }));
      case "authorize-holdout": {
        const hours = typeof flags["ttl-hours"] === "string" ? Number(flags["ttl-hours"]) : 24;
        const out = await authorizeHoldout(prisma, { unitId: arg(flags, 0, "unitId"), operator: need(flags, "operator"), ttlMs: hours * 3_600_000, note: typeof flags.note === "string" ? flags.note : undefined });
        return print({ status: "AUTHORIZED", by: out.authorisation.actor, expiresAt: out.authorisation.expiresAt, hypothesis: out.context.hypothesisId, instrument: out.context.instrumentKey, period: { start: out.context.periodStart, end: out.context.periodEnd }, priorLooksAtThisPeriod: out.priorLooks, note: "One read, for this exact walk-forward result. The result stays research-only whatever the outcome." });
      }
      case "evaluate-holdout":
        return print(await evaluateHoldout(prisma, arg(flags, 0, "unitId"), deps));
      case "register-model": {
        const out = await registerCampaignModel(prisma, { unitId: arg(flags, 0, "unitId"), registeredBy: need(flags, "by"), instrumentKeys: need(flags, "instrument-key").split(","), maxStalenessDays: Number(need(flags, "max-staleness-days")), targetEffectiveSignals: Number(need(flags, "observe-signals")) });
        return print({ status: out.status, modelVersionId: out.model.id, family: out.model.family, version: out.model.version, artefactHash: out.model.artefactHash, state: "EXPERIMENTAL unless already moved", note: "Not observed until an operator runs `observe`. Evidence label only; no trading authority." });
      }
      case "observe":
        return print({ ...(await startProspectiveObservation(prisma, { modelVersionId: arg(flags, 0, "modelVersionId"), operator: need(flags, "operator"), reason: need(flags, "reason") })), note: "Scored by the shadow service only when GENESIS_SHADOW_ENABLED=true. Creates no orders." });
      case "trials":
        return print(await programmeTrials(prisma));
      case "declare-legacy-trials": {
        const row = await declareLegacyTrials(prisma, { trials: Number(need(flags, "count")), actor: need(flags, "by"), note: need(flags, "note") });
        return print({ declared: row.trials, programmeTrials: await programmeTrials(prisma) });
      }
      default:
        throw new Error(`unknown command ${command ?? "(none)"}; see the header of campaign-cli.ts`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
