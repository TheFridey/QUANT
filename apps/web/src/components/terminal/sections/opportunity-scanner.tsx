"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, Panel } from "@/components/terminal/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatAge, formatUsd, signedClass } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Read-only OPERATION HORIZON scanner views (GET /research/opportunities, GET /research/markets/:id). */

type Reason = { code: string; stage?: string; detail: string };

export type ScannerMarket = {
  id: string;
  symbol: string;
  displayName: string;
  assetClass: string;
  venue: string;
  quoteCurrency: string;
  session: string;
  registryProviderId: string;
  executionCapabilities: string[];
  enabled: boolean;
  notes: string | null;
  provider: { id: string | null; readiness: string; ingestActive: boolean; ingestReason: string | null };
  readiness: {
    state: string;
    evaluable: boolean;
    paperExecutable: boolean;
    reasons: Reason[];
    session: { status: string; reason: string };
    quote: { ageMs: number | null; dataState: string | null; price: number | null; spreadBps: number | null; liquidityUsd: number | null };
  };
  readinessSplit: {
    liveQuote: { ready: boolean; state: string; reasons: Reason[] };
    execution: { ready: boolean; state: string; blockers: Reason[] };
  };
  researchUnavailable?: boolean;
  research: null | {
    history: Array<{ datasetId: string; sourceId: string; interval: string; bars: number; firstOpen: string | null; lastOpen: string | null }>;
    results: Array<{ campaignName: string; unitId: string; hypothesisId: string; interval: string; stage: string | null; status: string; verdict: string; why: string; createdAt: string }>;
    summary: { hypothesesTested: number; rejected: number; pendingHoldout: number; holdoutPassed: number; underObservation: number; latestAt: string | null };
  };
  observedAt: string | null;
  volatility: { samples: number; stdevLogReturnBps: number | null; regime: string };
  cost: { totalBps: number; feeBps: number; spreadBps: number; slippageBps: number; basis: string };
  strategies: Array<{ id: string; name: string; status: string; moduleRef: string | null }>;
  evidence: null | {
    status: string;
    family: string;
    version: string;
    modelState: string;
    signals: number;
    grossMeanBps: number;
    grossLowerBps: number;
    grossUpperBps: number;
  };
  pnl: null | { realisedPnlUsd: string; realisedEntries: number; openPositions: number; openCostBasisUsd: string };
  correlationBasis: string;
};

type LeaderboardRow = {
  rank: number | null;
  instrumentId: string;
  symbol: string;
  assetClass: string;
  state: string;
  decision: "SELECTED" | "ABSTAIN" | "NOT_EVALUATED";
  reasons: Array<{ code: string; detail: string }>;
  expectedNetBps: number | null;
  netLowerBps: number | null;
  netUpperBps: number | null;
  appliedCostBps: number | null;
  correlationPenaltyBps: number | null;
};

export type OpportunitiesResponse = {
  generatedAt: string;
  markets: ScannerMarket[];
  unattributedPnl: null | { realisedPnlUsd: string; realisedEntries: number };
  leaderboard: { rows: LeaderboardRow[]; selected: number; abstained: number; notEvaluated: number; method: string };
};

const ASSET_CLASS_LABEL: Record<string, string> = {
  SPOT_CRYPTO_PAIR: "Crypto (Solana)",
  FX_SPOT: "FX",
  COMMODITY_PROXY: "Commodities",
  EQUITY_ETF_PROXY: "ETFs",
  EQUITY_INDEX: "Indices (research only)",
  FUTURES_PROXY: "Futures proxies",
};

export function stateClass(state: string): string {
  if (state === "PAPER_EXECUTABLE") return "border-profit/40 text-profit";
  if (state === "OBSERVABLE" || state === "RESEARCH_ONLY") return "border-warning/40 text-warning";
  return "border-loss/40 text-loss";
}

export function useOpportunities() {
  const [data, setData] = useState<OpportunitiesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api<OpportunitiesResponse>("/research/opportunities"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load opportunities");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, reload: load };
}

export function groupByAssetClass<T extends { assetClass: string }>(rows: T[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(row.assetClass, [...(groups.get(row.assetClass) ?? []), row]);
  const order = Object.keys(ASSET_CLASS_LABEL);
  return [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
}

export function assetClassLabel(assetClass: string): string {
  return ASSET_CLASS_LABEL[assetClass] ?? assetClass;
}

/** Research history held for a market: independent of live quotes and of any execution path. */
export function researchHistoryLabel(market: ScannerMarket): string {
  if (!market.research) return "unavailable (unknown)";
  const { history } = market.research;
  if (history.length === 0) return "none stored";
  return history.map((h) => `${h.bars.toLocaleString("en-GB")} ${h.interval} bars to ${h.lastOpen?.slice(0, 10) ?? "?"}`).join(" · ");
}

/** Campaign outcomes for a market. No campaign means the answer is unknown, never "no edge" and never zero. */
export function researchEvidenceLabel(market: ScannerMarket): string {
  if (!market.research) return "unavailable (unknown)";
  const s = market.research.summary;
  if (s.hypothesesTested === 0) return "no campaign has run (unknown)";
  const parts = [`${s.hypothesesTested} tested`, `${s.rejected} rejected`];
  if (s.pendingHoldout) parts.push(`${s.pendingHoldout} pending holdout`);
  if (s.holdoutPassed) parts.push(`${s.holdoutPassed} passed holdout (research only)`);
  return parts.join(" · ");
}

const bps = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(1)} bps`);

/** The first reason at the blocking rung: why this market cannot trade (or is research only). */
export function blockingReason(market: ScannerMarket): Reason | null {
  if (market.readiness.paperExecutable) return null;
  return market.readiness.reasons.find((r) => r.stage === market.readiness.state) ?? market.readiness.reasons[0] ?? null;
}

export function OpportunityScannerSection() {
  const { data, error, reload } = useOpportunities();
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="space-y-3 animate-odin-fade">
      <OpportunityLeaderboard data={data} error={error} onReload={() => void reload()} />
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Market readiness" extra={data ? `${data.markets.length} registry markets` : undefined}>
          {!data ? (
            <EmptyState title={error ? "Scanner unavailable" : "Loading market readiness"} detail={error ?? undefined} />
          ) : (
            <div className="divide-y divide-border">
              {groupByAssetClass(data.markets).map(([assetClass, markets]) => (
                <section key={assetClass} aria-labelledby={`readiness-${assetClass}`} className="px-3 py-2">
                  <h3 id={`readiness-${assetClass}`} className="text-[10px] uppercase tracking-[0.14em] text-muted">
                    {assetClassLabel(assetClass)}
                  </h3>
                  <ul className="mt-1 space-y-2">
                    {markets.map((market) => (
                      <MarketReadinessRow
                        key={market.id}
                        market={market}
                        selected={selected === market.id}
                        onSelect={() => setSelected(market.id)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </Panel>
        <MarketDiagnostics id={selected} />
      </div>
    </div>
  );
}

function MarketReadinessRow({ market, selected, onSelect }: { market: ScannerMarket; selected: boolean; onSelect: () => void }) {
  const reason = blockingReason(market);
  const { quote } = market.readiness;
  return (
    <li aria-label={`${market.symbol} readiness`} className={cn("rounded border border-border p-2 text-xs", selected && "bg-white/[0.03]")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="text-sm font-medium">{market.symbol}</span>{" "}
          <span className="text-muted">{market.displayName}</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge className={stateClass(market.readiness.state)}>{market.readiness.state}</Badge>
          <Button size="xs" variant="outline" aria-pressed={selected} onClick={onSelect} aria-label={`Diagnostics for ${market.symbol}`}>
            Diagnostics
          </Button>
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4">
        <Fact label="Live market data" value={market.readinessSplit.liveQuote.ready ? "live quote" : market.readinessSplit.liveQuote.state.replaceAll("_", " ").toLowerCase()} />
        <Fact label="Execution path" value={market.readinessSplit.execution.ready ? "paper-executable" : `${market.readinessSplit.execution.state.replaceAll("_", " ").toLowerCase()} (${market.readinessSplit.execution.blockers.length} blocker${market.readinessSplit.execution.blockers.length === 1 ? "" : "s"})`} />
        <Fact label="Research history" value={researchHistoryLabel(market)} />
        <Fact label="Research evidence" value={researchEvidenceLabel(market)} />
        <Fact label="Provider" value={`${market.provider.id ?? "none"} · ${market.provider.readiness}`} />
        <Fact label="Session" value={`${market.readiness.session.status} (${market.readiness.session.reason})`} />
        <Fact label="Quote" value={quote.ageMs === null ? "none" : `${quote.dataState ?? "?"} · ${formatAge(quote.ageMs)} old`} />
        <Fact label="Est. round trip" value={`${bps(market.cost.totalBps)} (${market.cost.basis === "OBSERVED_SPREAD" ? "observed spread" : "estimated spread"})`} />
        <Fact
          label="Volatility"
          value={market.volatility.stdevLogReturnBps === null ? `n/a (${market.volatility.samples} returns)` : `${bps(market.volatility.stdevLogReturnBps)} · ${market.volatility.regime}`}
        />
        <Fact label="Strategy" value={market.strategies.length ? market.strategies.map((s) => `${s.name} (${s.status})`).join(", ") : "none assigned"} />
        <Fact label="Model evidence" value={market.evidence ? `${market.evidence.family}@${market.evidence.version} · ${market.evidence.modelState} · ${market.evidence.signals} signals` : "none"} />
        <Fact
          label="Paper P&L"
          value={market.pnl ? `${formatUsd(market.pnl.realisedPnlUsd)} realised · ${market.pnl.openPositions} open` : "no trades"}
          valueClassName={market.pnl ? signedClass(market.pnl.realisedPnlUsd) : undefined}
        />
      </dl>
      {reason ? (
        <p className="mt-2 text-muted">
          <span className="text-foreground/90">{market.readiness.state === "RESEARCH_ONLY" ? "Research only:" : "Cannot trade:"}</span>{" "}
          <span className="mono">{reason.code}</span> — {reason.detail}
        </p>
      ) : (
        <p className="mt-2 text-profit">Paper-executable path clear (selection still needs model evidence).</p>
      )}
    </li>
  );
}

function Fact({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-[0.12em] text-muted">{label}</dt>
      <dd className={cn("mono break-words", valueClassName)}>{value}</dd>
    </div>
  );
}

export function OpportunityLeaderboard({ data, error, onReload }: { data: OpportunitiesResponse | null; error: string | null; onReload: () => void }) {
  const selected = useMemo(() => data?.leaderboard.rows.filter((r) => r.decision === "SELECTED") ?? [], [data]);
  const abstainCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of data?.leaderboard.rows ?? []) {
      if (row.decision === "SELECTED") continue;
      const code = row.decision === "ABSTAIN" ? row.reasons[0]?.code ?? "ABSTAIN" : `NOT_EVALUATED: ${row.state}`;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [data]);

  return (
    <Panel
      title="Opportunity leaderboard"
      extra={
        <Button size="xs" variant="outline" onClick={onReload}>
          Refresh
        </Button>
      }
    >
      {!data ? (
        <EmptyState title={error ? "Leaderboard unavailable" : "Loading leaderboard"} detail={error ?? undefined} />
      ) : (
        <div className="space-y-2 p-3 text-xs">
          {selected.length === 0 ? (
            <EmptyState
              title="No opportunity clears costs"
              detail="The scanner abstains: no market has model evidence whose net edge after round-trip costs is above zero with confidence. Nothing is forced."
            />
          ) : (
            <div className="overflow-auto" role="region" aria-label="Selected opportunities" tabIndex={0}>
              <table className="w-full min-w-[640px] text-left">
                <caption className="sr-only">Selected opportunities ranked by net edge after costs</caption>
                <thead className="text-[10px] uppercase tracking-[0.12em] text-muted">
                  <tr className="border-b border-border">
                    <th scope="col" className="px-2 py-1">#</th>
                    <th scope="col" className="px-2 py-1">Market</th>
                    <th scope="col" className="px-2 py-1">Net edge</th>
                    <th scope="col" className="px-2 py-1">95% interval</th>
                    <th scope="col" className="px-2 py-1">Costs</th>
                    <th scope="col" className="px-2 py-1">Correlation penalty</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.map((row) => (
                    <tr key={row.instrumentId} className="border-b border-border/70">
                      <td className="mono px-2 py-1">{row.rank}</td>
                      <td className="px-2 py-1">{row.symbol}</td>
                      <td className="mono px-2 py-1 text-profit">{bps(row.expectedNetBps)}</td>
                      <td className="mono px-2 py-1">
                        [{bps(row.netLowerBps)}, {bps(row.netUpperBps)}]
                      </td>
                      <td className="mono px-2 py-1">{bps(row.appliedCostBps)}</td>
                      <td className="mono px-2 py-1">{bps(row.correlationPenaltyBps)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div>
            <h3 className="text-[10px] uppercase tracking-[0.14em] text-muted">
              Abstained {data.leaderboard.abstained} · not evaluated {data.leaderboard.notEvaluated}
            </h3>
            <ul className="mt-1 flex flex-wrap gap-1" aria-label="Abstention reasons">
              {abstainCounts.map(([code, count]) => (
                <li key={code}>
                  <Badge>
                    {code} × {count}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-[11px] text-muted">{data.leaderboard.method}</p>
        </div>
      )}
    </Panel>
  );
}

function MarketDiagnostics({ id }: { id: string | null }) {
  const [market, setMarket] = useState<ScannerMarket | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setMarket(null);
    setError(null);
    api<{ market: ScannerMarket }>(`/research/markets/${encodeURIComponent(id)}`)
      .then((body) => !cancelled && setMarket(body.market))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load diagnostics"));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!id) {
    return (
      <Panel title="Market diagnostics">
        <EmptyState title="Select a market" detail="Choose Diagnostics on a market to see every readiness check." />
      </Panel>
    );
  }
  if (!market) {
    return (
      <Panel title="Market diagnostics">
        <EmptyState title={error ? "Diagnostics unavailable" : "Loading diagnostics"} detail={error ?? undefined} />
      </Panel>
    );
  }
  return (
    <Panel title={`Diagnostics · ${market.symbol}`} extra={<Badge className={stateClass(market.readiness.state)}>{market.readiness.state}</Badge>}>
      <div className="space-y-3 p-3 text-xs">
        <dl className="grid grid-cols-2 gap-2">
          <Fact label="Registry provider" value={market.registryProviderId} />
          <Fact label="Routed provider" value={`${market.provider.id ?? "none"} · ${market.provider.readiness}`} />
          <Fact label="Ingest" value={market.provider.ingestActive ? "active" : market.provider.ingestReason ?? "inactive"} />
          <Fact label="Capabilities" value={market.executionCapabilities.join(", ")} />
          <Fact label="Last observation" value={market.observedAt ?? "never"} />
          <Fact label="Spread" value={bps(market.readiness.quote.spreadBps)} />
          <Fact label="Liquidity" value={market.readiness.quote.liquidityUsd === null ? "—" : formatUsd(String(market.readiness.quote.liquidityUsd))} />
          <Fact label="Cost breakdown" value={`fee ${bps(market.cost.feeBps)} · spread ${bps(market.cost.spreadBps)} · slip ${bps(market.cost.slippageBps)}`} />
          <Fact label="Correlation basis" value={market.correlationBasis} />
          <Fact label="Enabled" value={market.enabled ? "yes" : "no"} />
        </dl>
        {market.evidence ? (
          <p>
            Evidence ({market.evidence.status}): gross {bps(market.evidence.grossMeanBps)} [{bps(market.evidence.grossLowerBps)}, {bps(market.evidence.grossUpperBps)}] from{" "}
            {market.evidence.signals} hypothetical shadow signals.
          </p>
        ) : (
          <p className="text-muted">No model evidence: the scanner abstains for this market.</p>
        )}
        <div>
          <h3 className="text-[10px] uppercase tracking-[0.14em] text-muted">Market data</h3>
          <p className="mt-1">
            Live quote: <span className="mono">{market.readinessSplit.liveQuote.state}</span>. Research history: {researchHistoryLabel(market)}.
          </p>
          <p className="mt-1 text-muted">Stored history can be researched whether or not a live quote or an execution path exists.</p>
        </div>
        <div>
          <h3 className="text-[10px] uppercase tracking-[0.14em] text-muted">Execution</h3>
          <p className="mt-1">
            <span className="mono">{market.readinessSplit.execution.state}</span>
            {market.readinessSplit.execution.blockers.length ? `: ${market.readinessSplit.execution.blockers.map((b) => b.code).join(", ")}` : ""}
          </p>
        </div>
        <div>
          <h3 className="text-[10px] uppercase tracking-[0.14em] text-muted">Research evidence</h3>
          {!market.research ? (
            <p className="mt-1 text-muted">Research evidence could not be read. It is unknown, not empty.</p>
          ) : market.research.results.length === 0 ? (
            <p className="mt-1 text-muted">No campaign has run on this market. Its research result is unknown, not zero.</p>
          ) : (
            <ul className="mt-1 space-y-1" aria-label="Campaign results">
              {market.research.results.slice(0, 12).map((r) => (
                <li key={r.unitId}>
                  <span className="mono">{r.hypothesisId}</span> {r.interval} · <span className="mono">{r.status}</span> — <span className="text-muted">{r.why}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-muted">A historical result, even one that passed its holdout, is not an executable strategy.</p>
        </div>
        <div>
          <h3 className="text-[10px] uppercase tracking-[0.14em] text-muted">Readiness checks</h3>
          {market.readiness.reasons.length === 0 ? (
            <p className="mt-1 text-profit">All checks pass.</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {market.readiness.reasons.map((reason) => (
                <li key={`${reason.stage}-${reason.code}`}>
                  <span className="mono">{reason.stage}</span> · <span className="mono">{reason.code}</span> — <span className="text-muted">{reason.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {market.notes ? <p className="text-muted">{market.notes}</p> : null}
      </div>
    </Panel>
  );
}
