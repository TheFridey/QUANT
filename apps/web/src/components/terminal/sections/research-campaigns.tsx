"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyState, Panel } from "@/components/terminal/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatLondonDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * OPERATION EVIDENCE research campaigns (GET /research/campaigns, GET /research/campaigns/runs/:id).
 * Shows what ran, on which data and under which assumptions, why each hypothesis was rejected, what evidence
 * is missing, and how far any result has come from a historical backtest towards prospective observation.
 * Nothing shown here is an executable strategy.
 */

type Trials = { total: number; legacyRegistry: number; legacyDeclared: number; campaignSettled: number; campaignOutstanding: number };

type CampaignRow = {
  id: string;
  name: string;
  synthetic: boolean;
  createdAt: string;
  datasets: Array<{ key: string; market: string; instrument: string; interval: string; source: string; asOf: string }>;
  hypotheses: number;
  latestRun: null | { id: string; runNumber: number; state: string; codeVersion: string; units: Record<string, number> };
};

type Stage = { stage: string | null; status: string; why: string; missing: string[]; nextSteps: string[]; executable: false };

type Prospective = {
  predictions: number;
  abstained: number;
  resolved: number;
  open: number;
  effectiveOutcomes: number;
  effectiveSignals: number;
  overlapShare: number | null;
  costs: { meanCostBpsApplied: number | null; estimatedCostBps: number | null };
  meanNetSignals: number | null;
  netAdvantage: null | { estimate: number; lower: number; upper: number };
  calibration: null | { brier: number; ece: number };
  drift: { brierDecay: number | null; maxPsi: number | null; flags: string[] };
  sufficient: boolean;
  missing: string[];
};

type DatasetIdentity = {
  key: string;
  instrument: string;
  interval: string;
  calendar: string;
  asOf: string;
  availabilityPolicy: string;
  bars: number;
  firstT: string | null;
  lastT: string | null;
  contentHash: string;
  source: Record<string, string | number | boolean | null>;
  cleaning: { notAvailableAtAsOf: number; weekendStubsExcluded: unknown[] };
};

type Unit = {
  id: string;
  seq: number;
  datasetKey: string;
  hypothesisKind: string;
  hypothesisId: string;
  state: string;
  attempts: number;
  lastError: string | null;
  plannedTrials: number;
  trials: { reserved: number | null; settled: number | null; priorTrials: number | null };
  walkForward: null | {
    verdict: string;
    reasons: string[];
    walkForwardPassed: boolean;
    holdoutStatus: string;
    trialCount: number;
    runtimeMs: number;
    peakRssMb: number;
    resultHash: string;
    dataset: DatasetIdentity;
    provenance: { codeVersion?: string; costAssumptions?: string[]; validationCostBpsPerSide?: number; seeds?: { validation: number; ml: number }; searchSpaceHash?: string };
    summary: { oos?: null | { trades: number; netReturn: number; grossReturn: number | null; maxDrawdown: number }; dsrProgramme?: null | { dsr: number | null; trials: number }; pbo?: number | null; champion?: null | { auc: number | null; brierSkill: number | null; signals: number }; holdoutPeriod?: null | { start: string; end: string } };
  };
  holdout: null | { verdict: string; reasons: string[]; holdoutStatus: string; createdAt: string };
  holdoutLedger: Array<{ kind: string; actor: string; createdAt: string; expiresAt: string | null; note: string | null }>;
  model: null | { id: string; family: string; version: string; state: string; stateReason: string | null };
  prospective: Prospective | null;
  stage: Stage;
};

type RunDetail = {
  campaign: { id: string; name: string; synthetic: boolean; specHash: string; spec: { limits: Record<string, number>; validation: { folds: number; holdoutFraction: number; seed: number }; holdoutPolicy: string } };
  run: { id: string; runNumber: number; reason: string; requestedBy: string; codeVersion: string; state: string; startedAt: string | null; finishedAt: string | null };
  progress: { total: number; byState: Record<string, number> };
  units: Unit[];
  events: Array<{ kind: string; unitId: string | null; actor: string; createdAt: string }>;
  programmeTrials: Trials;
};

const STAGE_LABEL: Record<string, string> = {
  HISTORICAL_RESULT: "Historical result",
  PENDING_HOLDOUT: "Pending holdout",
  HOLDOUT_EVALUATED: "Holdout evaluated",
  PROSPECTIVE_OBSERVATION: "Prospective observation",
  SUFFICIENT_PROSPECTIVE_EVIDENCE: "Sufficient prospective evidence",
  PAPER_EXECUTION_READINESS: "Paper-execution readiness",
};
const LADDER = Object.keys(STAGE_LABEL);

const pct = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) ? "unknown" : `${(value * 100).toFixed(2)}%`);
const bps = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) ? "unknown" : `${(value * 10_000).toFixed(1)} bps`);
const num = (value: number | null | undefined, digits = 3) => (value === null || value === undefined || !Number.isFinite(value) ? "unknown" : value.toFixed(digits));

function stageClass(unit: Unit): string {
  const s = unit.stage;
  if (s.stage === "SUFFICIENT_PROSPECTIVE_EVIDENCE" || s.status === "HOLDOUT_PASSED_RESEARCH_ONLY") return "border-profit/40 text-profit";
  if (s.stage === "PENDING_HOLDOUT" || s.stage === "PROSPECTIVE_OBSERVATION" || s.stage === null) return "border-warning/40 text-warning";
  return "border-loss/40 text-loss";
}

export function ResearchCampaignsSection() {
  const [list, setList] = useState<{ campaigns: CampaignRow[]; programmeTrials: Trials } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await api<{ campaigns: CampaignRow[]; programmeTrials: Trials }>("/research/campaigns");
      setList(body);
      setError(null);
      setRunId((current) => current ?? body.campaigns.find((c) => c.latestRun)?.latestRun?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load campaigns");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-3 animate-odin-fade">
      <Panel
        title="Research campaigns"
        extra={
          <Button size="xs" variant="outline" onClick={() => void load()}>
            Refresh
          </Button>
        }
      >
        {!list ? (
          <EmptyState title={error ? "Campaigns unavailable" : "Loading campaigns"} detail={error ?? undefined} />
        ) : (
          <div className="space-y-2 p-3 text-xs">
            <p className="text-muted">
              A campaign declares its datasets, hypotheses, costs and limits before anything runs. Results are research evidence only: no result here is an executable strategy.
            </p>
            <p aria-label="Programme trial count">
              <span className="text-[10px] uppercase tracking-[0.12em] text-muted">Trials run across the whole programme</span>{" "}
              <span className="mono">{list.programmeTrials.total.toLocaleString("en-GB")}</span>{" "}
              <span className="text-muted">
                (earlier registry {list.programmeTrials.legacyRegistry.toLocaleString("en-GB")}, declared {list.programmeTrials.legacyDeclared.toLocaleString("en-GB")}, campaigns{" "}
                {list.programmeTrials.campaignSettled.toLocaleString("en-GB")}, reserved by unfinished or failed units {list.programmeTrials.campaignOutstanding.toLocaleString("en-GB")}). Every result is judged against this
                count, so more searching makes the bar higher.
              </span>
            </p>
            {list.campaigns.length === 0 ? (
              <EmptyState title="No campaign has run" detail="No research campaign is recorded. That means results are unknown, not that nothing works or that anything does." />
            ) : (
              <ul className="space-y-1" aria-label="Campaigns">
                {list.campaigns.map((c) => (
                  <li key={c.id} aria-label={`Campaign ${c.name}`} className={cn("rounded border border-border p-2", c.latestRun?.id === runId && "bg-white/[0.03]")}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="text-sm font-medium">{c.name}</span>{" "}
                        {c.synthetic ? <Badge className="border-warning/40 text-warning">Synthetic fixture</Badge> : null}
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge>{c.latestRun ? `Run ${c.latestRun.runNumber} · ${c.latestRun.state}` : "Not started"}</Badge>
                        {c.latestRun ? (
                          <Button size="xs" variant="outline" aria-pressed={c.latestRun.id === runId} aria-label={`Evidence for ${c.name}`} onClick={() => setRunId(c.latestRun!.id)}>
                            Evidence
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <p className="mt-1 text-muted">
                      {c.datasets.map((d) => `${d.instrument} ${d.interval} (${d.source === "WAREHOUSE" ? "warehouse" : "file"}, as of ${d.asOf.slice(0, 10)})`).join(" · ")} · {c.hypotheses}{" "}
                      {c.hypotheses === 1 ? "hypothesis" : "hypotheses"} per dataset
                      {c.latestRun ? ` · units ${Object.entries(c.latestRun.units).map(([state, n]) => `${n} ${state.toLowerCase()}`).join(", ")}` : ""}
                    </p>
                    {c.synthetic ? <p className="mt-1 text-warning">Constructed data with a planted pattern, used to demonstrate the workflow. Not evidence about any market.</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Panel>
      {runId ? <RunEvidence key={runId} runId={runId} /> : null}
    </div>
  );
}

function RunEvidence({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await api<RunDetail>(`/research/campaigns/runs/${encodeURIComponent(runId)}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load run");
    }
  }, [runId]);
  useEffect(() => {
    void load();
  }, [load]);

  const authorise = useCallback(
    async (unit: Unit) => {
      setNotice(null);
      try {
        const out = await api<{ expiresAt: string | null; priorLooks: number }>(`/research/campaigns/units/${encodeURIComponent(unit.id)}/authorize-holdout`, { method: "POST", body: JSON.stringify({ ttlHours: 24 }) });
        setNotice(`Holdout read authorised for ${unit.hypothesisId} until ${formatLondonDateTime(out.expiresAt)}. Earlier looks at this period: ${out.priorLooks}. Run the holdout evaluation from the campaign CLI.`);
        await load();
      } catch (err) {
        setNotice(`Not authorised: ${err instanceof Error ? err.message : "request failed"}`);
      }
    },
    [load],
  );

  if (!detail) {
    return (
      <Panel title="Campaign evidence">
        <EmptyState title={error ? "Evidence unavailable" : "Loading evidence"} detail={error ?? undefined} />
      </Panel>
    );
  }
  const datasets = new Map<string, DatasetIdentity>();
  for (const u of detail.units) if (u.walkForward?.dataset && !datasets.has(u.datasetKey)) datasets.set(u.datasetKey, u.walkForward.dataset);
  const first = detail.units.find((u) => u.walkForward)?.walkForward ?? null;
  const { limits, validation } = detail.campaign.spec;

  return (
    <Panel title={`Evidence · ${detail.campaign.name}`} extra={<Badge>{`Run ${detail.run.runNumber} · ${detail.run.state}`}</Badge>}>
      <div className="space-y-3 p-3 text-xs">
        {detail.campaign.synthetic ? (
          <p role="note" className="rounded border border-warning/40 p-2 text-warning">
            Synthetic fixture: this campaign ran on constructed data with a planted pattern. It demonstrates the workflow and says nothing about a real market.
          </p>
        ) : null}
        <section aria-labelledby="evidence-what-ran">
          <h3 id="evidence-what-ran" className="text-[10px] uppercase tracking-[0.14em] text-muted">
            What ran
          </h3>
          <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4">
            <Fact label="Progress" value={`${Object.entries(detail.progress.byState).map(([s, n]) => `${n} ${s.toLowerCase()}`).join(", ")} of ${detail.progress.total}`} />
            <Fact label="Code version" value={detail.run.codeVersion.slice(0, 12)} />
            <Fact label="Validation" value={`${validation.folds} walk-forward folds · last ${(validation.holdoutFraction * 100).toFixed(0)}% held out · seed ${validation.seed}`} />
            <Fact label="Limits" value={`${limits.maxTrials} trials · ${Math.round((limits.maxRuntimeMsPerUnit ?? 0) / 1000)} s and ${limits.maxMemoryMbPerUnit} MB per hypothesis · ${limits.maxConcurrency} at a time`} />
            <Fact label="Holdout policy" value="Withheld unless an operator authorises one read" />
            <Fact label="Why this run" value={detail.run.reason} />
            <Fact label="Started" value={detail.run.startedAt ? formatLondonDateTime(detail.run.startedAt) : "not started"} />
            <Fact label="Finished" value={detail.run.finishedAt ? formatLondonDateTime(detail.run.finishedAt) : "not finished"} />
          </dl>
        </section>
        <section aria-labelledby="evidence-data">
          <h3 id="evidence-data" className="text-[10px] uppercase tracking-[0.14em] text-muted">
            Data and assumptions
          </h3>
          {datasets.size === 0 ? (
            <p className="mt-1 text-muted">No dataset has been read yet, so its contents are unknown.</p>
          ) : (
            <ul className="mt-1 space-y-1" aria-label="Datasets">
              {[...datasets.values()].map((d) => (
                <li key={d.key}>
                  <span className="mono">{d.instrument}</span> {d.interval} · {d.bars.toLocaleString("en-GB")} bars {d.firstT?.slice(0, 10)} to {d.lastT?.slice(0, 10)} · {String(d.source.kind).toLowerCase()} source · {d.calendar} calendar ·
                  as of {d.asOf.slice(0, 10)} · content <span className="mono">{d.contentHash.slice(0, 12)}</span>
                  <span className="text-muted">
                    {" "}
                    · {d.cleaning.weekendStubsExcluded.length} weekend stub bars excluded, {d.cleaning.notAvailableAtAsOf} bars not yet available · {d.availabilityPolicy}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {first?.provenance.costAssumptions?.length ? (
            <p className="mt-1 text-muted">
              Costs: {first.provenance.costAssumptions.join("; ")}
              {first.provenance.validationCostBpsPerSide !== undefined ? ` Applied in validation: ${first.provenance.validationCostBpsPerSide.toFixed(1)} bps per side (a candidate must also survive twice this).` : ""}
            </p>
          ) : null}
        </section>
        {notice ? (
          <p role="status" className="rounded border border-border p-2">
            {notice}
          </p>
        ) : null}
        <section aria-labelledby="evidence-hypotheses">
          <h3 id="evidence-hypotheses" className="text-[10px] uppercase tracking-[0.14em] text-muted">
            Hypotheses
          </h3>
          <ul className="mt-1 space-y-2" aria-label="Hypotheses">
            {detail.units.map((u) => (
              <li key={u.id} aria-label={`Hypothesis ${u.hypothesisId} on ${u.datasetKey}`} className="rounded border border-border p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="mono text-sm">{u.hypothesisId}</span> <span className="text-muted">on {u.datasetKey}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={stageClass(u)}>{u.stage.stage ? STAGE_LABEL[u.stage.stage] : "No result"}</Badge>
                    <Badge>{u.stage.status.replaceAll("_", " ")}</Badge>
                    <Button size="xs" variant="outline" aria-expanded={open === u.id} aria-label={`Details for ${u.hypothesisId} on ${u.datasetKey}`} onClick={() => setOpen(open === u.id ? null : u.id)}>
                      {open === u.id ? "Hide" : "Details"}
                    </Button>
                  </div>
                </div>
                <p className="mt-1">
                  <span className="text-muted">{u.walkForward && !u.walkForward.walkForwardPassed ? "Rejected because:" : "Status:"}</span> {u.stage.why}
                </p>
                {open === u.id ? <UnitDetails unit={u} onAuthorise={() => void authorise(u)} /> : null}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Panel>
  );
}

function UnitDetails({ unit, onAuthorise }: { unit: Unit; onAuthorise: () => void }) {
  const wf = unit.walkForward;
  const reached = unit.stage.stage ? LADDER.indexOf(unit.stage.stage) : -1;
  const p = unit.prospective;
  return (
    <div className="mt-2 space-y-2 border-t border-border pt-2">
      <ol className="flex flex-wrap gap-1" aria-label="Evidence ladder">
        {LADDER.map((stage, i) => (
          <li key={stage}>
            <Badge className={i <= reached ? "border-profit/40 text-profit" : undefined} aria-label={`${STAGE_LABEL[stage]}: ${i <= reached ? "reached" : "not reached"}`}>
              {i + 1}. {STAGE_LABEL[stage]}
            </Badge>
          </li>
        ))}
      </ol>
      <p className="text-muted">Not an executable strategy at any step: paper execution needs the separate operator promotion process.</p>
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <h4 className="text-[10px] uppercase tracking-[0.12em] text-muted">Historical (walk-forward on past data)</h4>
          {!wf ? (
            <p className="mt-1 text-muted">No result: unknown, not zero.{unit.lastError ? ` Last error: ${unit.lastError}` : ""}</p>
          ) : (
            <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
              <Fact label="Verdict" value={wf.verdict.replaceAll("_", " ")} />
              <Fact label="Trials run" value={`${wf.trialCount} (limit ${unit.plannedTrials})`} />
              <Fact label="Judged against" value={`${((unit.trials.priorTrials ?? 0) + wf.trialCount).toLocaleString("en-GB")} programme trials`} />
              <Fact label="Runtime" value={`${(wf.runtimeMs / 1000).toFixed(1)} s · ${wf.peakRssMb.toFixed(0)} MB`} />
              {wf.summary.oos ? <Fact label="Out-of-sample net" value={`${pct(wf.summary.oos.netReturn)} over ${wf.summary.oos.trades} trades (gross ${pct(wf.summary.oos.grossReturn)})`} /> : null}
              {wf.summary.oos ? <Fact label="Max drawdown" value={pct(wf.summary.oos.maxDrawdown)} /> : null}
              {wf.summary.dsrProgramme !== undefined ? <Fact label="Deflated Sharpe" value={num(wf.summary.dsrProgramme?.dsr)} /> : null}
              {wf.summary.pbo !== undefined ? <Fact label="Overfit probability" value={num(wf.summary.pbo, 2)} /> : null}
              {wf.summary.champion ? <Fact label="Model skill" value={`AUC ${num(wf.summary.champion.auc)} · Brier skill ${num(wf.summary.champion.brierSkill, 4)} · ${wf.summary.champion.signals} signals`} /> : null}
            </dl>
          )}
          {wf && wf.reasons.length > 1 ? (
            <ul className="mt-1 list-disc pl-4 text-muted" aria-label="All reasons">
              {wf.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <div>
          <h4 className="text-[10px] uppercase tracking-[0.12em] text-muted">Prospective (frozen model on new bars, no orders)</h4>
          {!unit.model ? (
            <p className="mt-1 text-muted">Not under observation. Prospective results are unknown, not zero.</p>
          ) : (
            <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
              <Fact label="Frozen model" value={`${unit.model.family}@${unit.model.version.slice(0, 10)} · ${unit.model.state.replaceAll("_", " ")}`} />
              <Fact label="Predictions" value={p ? `${p.predictions} made · ${p.abstained} abstained · ${p.open} awaiting their horizon` : "none yet"} />
              <Fact label="Resolved outcomes" value={p ? `${p.resolved} (${p.effectiveOutcomes} independent)` : "none yet"} />
              <Fact label="Overlap" value={p?.overlapShare === null || p?.overlapShare === undefined ? "unknown" : `${(p.overlapShare * 100).toFixed(0)}% of outcomes overlap another`} />
              <Fact label="Net of signals" value={bps(p?.meanNetSignals)} />
              <Fact label="Advantage (95% interval)" value={p?.netAdvantage ? `${bps(p.netAdvantage.estimate)} [${bps(p.netAdvantage.lower)}, ${bps(p.netAdvantage.upper)}]` : "unknown"} />
              <Fact label="Costs applied" value={p?.costs.meanCostBpsApplied === null || p?.costs.meanCostBpsApplied === undefined ? `unknown (estimate ${p?.costs.estimatedCostBps ?? "?"} bps round trip)` : `${p.costs.meanCostBpsApplied.toFixed(1)} bps round trip`} />
              <Fact label="Drift" value={p ? (p.drift.flags.length ? p.drift.flags.join("; ") : `none flagged · Brier change ${num(p.drift.brierDecay, 4)}`) : "unknown"} />
            </dl>
          )}
        </div>
      </div>
      <div>
        <h4 className="text-[10px] uppercase tracking-[0.12em] text-muted">Holdout</h4>
        <p className="mt-1">
          {unit.holdout
            ? `${unit.holdout.holdoutStatus.replaceAll("_", " ")} on ${formatLondonDateTime(unit.holdout.createdAt)}: ${unit.holdout.verdict.replaceAll("_", " ")}. ${unit.holdout.reasons.at(-1) ?? ""}`
            : wf?.walkForwardPassed
              ? `Withheld. Period ${wf.summary.holdoutPeriod?.start.slice(0, 10) ?? "?"} to ${wf.summary.holdoutPeriod?.end.slice(0, 10) ?? "?"} has not been read.`
              : "Not reached: a hypothesis that fails an earlier test never gets a holdout read."}
        </p>
        {unit.holdoutLedger.length ? (
          <ul className="mt-1 text-muted" aria-label="Holdout record">
            {unit.holdoutLedger.map((row) => (
              <li key={`${row.kind}-${row.createdAt}`}>
                {formatLondonDateTime(row.createdAt)} · {row.kind.replaceAll("_", " ").toLowerCase()} by {row.actor}
                {row.expiresAt ? ` (valid until ${formatLondonDateTime(row.expiresAt)})` : ""}
              </li>
            ))}
          </ul>
        ) : null}
        {unit.stage.stage === "PENDING_HOLDOUT" && unit.stage.status === "WITHHELD" ? (
          <Button size="xs" variant="outline" className="mt-1" onClick={onAuthorise} aria-label={`Authorise one holdout read for ${unit.hypothesisId}`}>
            Authorise one holdout read (admin)
          </Button>
        ) : null}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <h4 className="text-[10px] uppercase tracking-[0.12em] text-muted">Missing evidence</h4>
          <ul className="mt-1 list-disc pl-4" aria-label="Missing evidence">
            {unit.stage.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="text-[10px] uppercase tracking-[0.12em] text-muted">Next steps</h4>
          <ul className="mt-1 list-disc pl-4" aria-label="Next steps">
            {unit.stage.nextSteps.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-[0.12em] text-muted">{label}</dt>
      <dd className="mono break-words">{value}</dd>
    </div>
  );
}
