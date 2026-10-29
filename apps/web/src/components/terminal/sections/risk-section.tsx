"use client";

import { useState } from "react";
import { Metric, Panel } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatPct, formatUsd } from "@/lib/format";

export function RiskSection() {
  const { snapshot, refresh } = useSnapshot();
  const [ackingId, setAckingId] = useState<string | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);
  if (!snapshot) return null;

  async function ackAlert(id: string) {
    setAckingId(id);
    setAckError(null);
    try {
      await api(`/terminal/alerts/${encodeURIComponent(id)}/ack`, { method: "POST", body: "{}" });
      await refresh();
    } catch (err) {
      setAckError(err instanceof Error ? err.message : "ACK failed");
    } finally {
      setAckingId(null);
    }
  }
  const config = snapshot.engine.config ?? {};
  const p = snapshot.portfolio;
  const execution = snapshot.execution;
  const funnel = snapshot.funnel?.summary ?? {};
  const protectedCount = p.positions.filter((row) => row.protected).length;
  const unprotectedCount = p.positions.length - protectedCount;
  const risk = snapshot.riskDiagnostics;
  const attribution = snapshot.instanceAttribution;
  const helperProtected = p.positions.filter((row) => row.protectionHelper).length;
  const venueConfirmed = p.positions.filter((row) => row.protectionVenueConfirmed).length;

  return (
    <div className="grid gap-3 lg:grid-cols-2 animate-odin-fade">
      <Panel title="Live risk">
        <div className="grid grid-cols-2 gap-4 p-4">
          <Metric label="Equity" value={<span className="mono">{p.equityUsd === null ? "Incomplete" : formatUsd(p.equityUsd)}</span>} />
          <Metric label="Exposure" value={<span className="mono">{formatUsd(p.exposureUsd)}</span>} />
          <Metric label="Current DD" value={<span className="mono text-loss">{formatPct(p.currentDrawdownPct)}</span>} />
          <Metric label="Max DD" value={<span className="mono text-loss">{formatPct(p.maxDrawdownPct)}</span>} />
          <Metric label="Open positions" value={<span className="mono">{p.positions.length}</span>} />
          <Metric label="HWM" value={<span className="mono">{formatUsd(p.highWaterMarkUsd)}</span>} />
          <Metric label="Protected" value={<span className="mono">{protectedCount}</span>} />
          <Metric label="Unprotected" value={<span className="mono">{unprotectedCount}</span>} />
          <Metric label="Helper protection" value={<span className="mono">{helperProtected}</span>} />
          <Metric label="Venue ACK" value={<span className="mono">{venueConfirmed}</span>} />
        </div>
      </Panel>
      <Panel title="Configured limits">
        <div className="grid grid-cols-2 gap-4 p-4 text-sm">
          <Metric label="Stop loss %" value={<span className="mono">{String(config.stopLossPct ?? "—")}</span>} />
          <Metric label="Take profit %" value={<span className="mono">{String(config.takeProfitPct ?? "—")}</span>} />
          <Metric label="Max positions" value={<span className="mono">{String(config.maxPositions ?? "—")}</span>} />
          <Metric label="Max position % equity" value={<span className="mono">{String(config.maxPositionPctEquity ?? "—")}</span>} />
          <Metric label="Max daily loss %" value={<span className="mono">{String(config.maxDailyLossPct ?? "—")}</span>} />
          <Metric label="Min liquidity" value={<span className="mono">{formatUsd(config.minLiquidityUsd != null ? String(config.minLiquidityUsd) : null)}</span>} />
        </div>
      </Panel>
      <Panel title="Execution mode">
        <dl className="grid grid-cols-2 gap-3 p-4 text-xs">
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Mode</dt>
            <dd className="mono">{execution?.mode ?? "PAPER"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Live allowed</dt>
            <dd className="mono">{execution?.liveAllowed ? "yes" : "no"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Pause new entries</dt>
            <dd className="mono">{execution?.pauseNewEntries ? "yes" : "no"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Entries suspended</dt>
            <dd className="mono">{execution?.entriesSuspended ? "yes" : "no"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">DEMO paper entries</dt>
            <dd className="mono">{execution?.allowDemoPaperEntries ? "allowed" : "blocked"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Multi-market ingest</dt>
            <dd className="mono">{execution?.multiMarketPaperIngest ? "on" : "off"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Trading environment</dt>
            <dd className="mono">{execution?.tradingEnvironment ?? "MARKET_DATA_PAPER"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Unresolved protection</dt>
            <dd className="mono">{execution?.unresolvedProtection ?? 0}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Metrics account</dt>
            <dd className="mono">{execution?.metricsAccountId ?? "primary"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Alpaca paper</dt>
            <dd className="mono">{execution?.providerReadiness?.alpaca_paper ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">OANDA practice</dt>
            <dd className="mono">{execution?.providerReadiness?.oanda_practice ?? "—"}</dd>
          </div>
          {execution?.refuseReason ? (
            <div className="col-span-2">
              <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Refuse reason</dt>
              <dd className="text-loss">{execution.refuseReason}</dd>
            </div>
          ) : null}
          <div className="col-span-2">
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Active strategy</dt>
            <dd className="mono">
              {snapshot.activeStrategy
                ? `${snapshot.activeStrategy.strategyId}@${snapshot.activeStrategy.strategyVersion}`
                : "default PULSE (no promotion)"}
            </dd>
          </div>
          {(execution?.unresolvedActions?.length ?? 0) > 0 ? (
            <div className="col-span-2">
              <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Unresolved actions</dt>
              <dd className="mt-1 space-y-1 text-[11px] text-loss">
                {execution!.unresolvedActions!.slice(0, 5).map((action) => (
                  <div key={action.id} className="mono">
                    {action.reason} · attempts={action.attempts}
                  </div>
                ))}
              </dd>
            </div>
          ) : null}
        </dl>
      </Panel>
      <Panel title="Risk hierarchy">
        <dl className="grid grid-cols-2 gap-3 p-4 text-xs">
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Dominant hard</dt>
            <dd className="mono">{risk?.dominantHard ?? execution?.riskDominantHard ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Blocks new entries</dt>
            <dd className="mono">{risk?.blocksNewEntries || execution?.riskBlocksNewEntries ? "yes" : "no"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Circuit breaker</dt>
            <dd className="mono">{risk?.circuitBreakerOpen || execution?.circuitBreakerOpen ? "OPEN" : "closed"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">ACK ≠ clear</dt>
            <dd className="mono text-[10px]">{(risk?.ackDoesNotClear ?? []).join(", ") || "—"}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Active controls</dt>
            <dd className="mt-1 space-y-1 text-[11px]">
              {(risk?.hierarchy ?? []).length === 0 ? (
                <span className="text-muted">None active</span>
              ) : (
                risk!.hierarchy.map((control) => (
                  <div key={control.kind} className="mono">
                    [{control.rank}] {control.kind}
                    {control.hard ? " HARD" : ""} · {control.reasonCodes.join(", ")}
                  </div>
                ))
              )}
            </dd>
          </div>
        </dl>
      </Panel>
      <Panel title="Opportunity funnel">
        <div className="grid grid-cols-3 gap-3 p-4 text-xs">
          {Object.entries(funnel).map(([stage, count]) => (
            <div key={stage}>
              <div className="text-[10px] uppercase tracking-[0.12em] text-muted">{stage}</div>
              <div className="mono mt-1">{count}</div>
            </div>
          ))}
        </div>
      </Panel>
      <Panel title="Instance attribution">
        <div className="p-4 text-xs space-y-2">
          <div className="grid grid-cols-2 gap-3">
            <Metric label="Portfolio net" value={<span className="mono">{formatUsd(attribution?.portfolioNetPnlUsd ?? null)}</span>} />
            <Metric label="Sample" value={<span className="mono">{attribution?.sampleSize ?? 0}</span>} />
          </div>
          {(attribution?.instances?.length ?? 0) === 0 ? (
            <p className="text-muted">No attributed closed trades yet (strategyVersion stamps on orders).</p>
          ) : (
            <ul className="divide-y divide-border/70">
              {attribution!.instances.slice(0, 6).map((row) => (
                <li key={row.strategyInstanceId} className="flex justify-between gap-2 py-1 mono text-[11px]">
                  <span>{row.strategyInstanceId}</span>
                  <span>
                    n={row.trades} · net {formatUsd(row.netPnlUsd)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {(attribution?.unattributedTrades ?? 0) > 0 ? (
            <p className="text-[10px] text-muted">Unattributed trades: {attribution!.unattributedTrades}</p>
          ) : null}
        </div>
      </Panel>
      <Panel title="Why blocked" className="lg:col-span-2">
        {(snapshot.whyBlocked ?? []).length === 0 ? (
          <p className="p-4 text-xs text-muted">No reject/block diagnostics on the latest cycle.</p>
        ) : (
          <ul className="divide-y divide-border/70 text-xs">
            {(snapshot.whyBlocked ?? []).slice(0, 12).map((row, index) => (
              <li key={`${row.agent}-${row.pairAddress}-${index}`} className="flex flex-col gap-1 px-3 py-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span>
                    <span className="text-muted">{row.agent}</span> · {row.pairAddress || "(account)"} · {row.decision}
                  </span>
                  <span className="mono text-muted">{row.reasonCodes.join(", ")}</span>
                </div>
                {(row.hardBlocks?.length ?? 0) > 0 ? (
                  <div className="text-[10px] text-loss">Hard: {(row.hardBlocks ?? []).join(", ")}</div>
                ) : null}
                {(row.advisories?.length ?? 0) > 0 ? (
                  <div className="text-[10px] text-muted">Advisory: {(row.advisories ?? []).join(", ")}</div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Observability" className="lg:col-span-2">
        {(snapshot.observability?.recent ?? []).length === 0 ? (
          <p className="p-4 text-xs text-muted">No durable ObservabilityEvent rows yet.</p>
        ) : (
          <ul className="divide-y divide-border/70 text-xs">
            {(snapshot.observability?.recent ?? []).slice(0, 10).map((row) => (
              <li key={row.id} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
                <span>
                  <span className="text-muted">{row.category}</span> · {row.name}
                </span>
                <span className="mono">
                  {row.value ?? "—"}
                  {row.unit ? ` ${row.unit}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Durable alerts" className="lg:col-span-2">
        {ackError ? <p className="border-b border-border/70 px-3 py-2 text-[11px] text-loss">{ackError}</p> : null}
        {(snapshot.alerts ?? []).length === 0 ? (
          <p className="p-4 text-xs text-muted">No open durable alerts.</p>
        ) : (
          <ul className="divide-y divide-border/70 text-xs">
            {(snapshot.alerts ?? []).map((alert) => (
              <li key={alert.id} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
                <span>
                  <span className="mono">{alert.severity}</span> · {alert.code}
                  {alert.ackClearsSafety === false ? (
                    <span className="ml-2 text-[10px] text-loss">ACK≠clear safety</span>
                  ) : null}
                  <span className="mt-1 block text-muted">{alert.message}</span>
                  <span className="mt-1 block text-[10px] text-muted">
                    ACK is notification-only — it never clears breaker, entry suspension, or unresolved protection.
                  </span>
                </span>
                <div className="flex flex-col items-end gap-2">
                  <span className="mono text-muted">{alert.createdAt}</span>
                  {!alert.acked ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={ackingId === alert.id}
                      onClick={() => void ackAlert(alert.id)}
                    >
                      {ackingId === alert.id ? "ACKing…" : "ACK"}
                    </Button>
                  ) : (
                    <span className="text-[10px] text-muted">acked</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
