"use client";

import { Metric, Panel } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { formatPct, formatUsd } from "@/lib/format";

export function RiskSection() {
  const { snapshot } = useSnapshot();
  if (!snapshot) return null;
  const config = snapshot.engine.config ?? {};
  const p = snapshot.portfolio;

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
    </div>
  );
}
