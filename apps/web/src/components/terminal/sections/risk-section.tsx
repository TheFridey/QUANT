"use client";

import { Metric, Panel } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { formatPct, formatUsd } from "@/lib/format";

export function RiskSection() {
  const { snapshot } = useSnapshot();
  if (!snapshot) return null;
  const config = snapshot.engine.config ?? {};
  const p = snapshot.portfolio;
  const execution = snapshot.execution;
  const funnel = snapshot.funnel?.summary ?? {};
  const protectedCount = p.positions.filter((row) => row.protected).length;
  const unprotectedCount = p.positions.length - protectedCount;

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
      <Panel title="Why blocked" className="lg:col-span-2">
        {(snapshot.whyBlocked ?? []).length === 0 ? (
          <p className="p-4 text-xs text-muted">No reject/block diagnostics on the latest cycle.</p>
        ) : (
          <ul className="divide-y divide-border/70 text-xs">
            {(snapshot.whyBlocked ?? []).slice(0, 12).map((row, index) => (
              <li key={`${row.agent}-${row.pairAddress}-${index}`} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
                <span>
                  <span className="text-muted">{row.agent}</span> · {row.pairAddress || "(account)"} · {row.decision}
                </span>
                <span className="mono text-muted">{row.reasonCodes.join(", ")}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Durable alerts" className="lg:col-span-2">
        {(snapshot.alerts ?? []).length === 0 ? (
          <p className="p-4 text-xs text-muted">No open durable alerts.</p>
        ) : (
          <ul className="divide-y divide-border/70 text-xs">
            {(snapshot.alerts ?? []).map((alert) => (
              <li key={alert.id} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
                <span>
                  <span className="mono">{alert.severity}</span> · {alert.code}
                  <span className="mt-1 block text-muted">{alert.message}</span>
                </span>
                <span className="mono text-muted">{alert.createdAt}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
