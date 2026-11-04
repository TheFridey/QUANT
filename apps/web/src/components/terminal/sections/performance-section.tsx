"use client";

import { EmptyState, Metric, Panel } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { formatAllHistoryWindow, formatDrawdown, formatPct, formatRate, formatUsd, signedClass } from "@/lib/format";
import { cn } from "@/lib/utils";

export function PerformanceSection() {
  const { snapshot } = useSnapshot();
  if (!snapshot) return null;
  const p = snapshot.portfolio;
  const sample = p.sampleSize ?? p.closedTrades;
  const dist = p.tradeDistribution ?? { wins: p.wins, losses: p.losses, breakeven: 0 };
  const total = dist.wins + dist.losses + dist.breakeven;

  return (
    <div className="grid gap-3 lg:grid-cols-[240px_minmax(0,1fr)] animate-odin-fade">
      <Panel title="Win rate" extra={`n=${sample}`}>
        <div className="grid place-items-center p-6">
          <WinRateRadial rate={p.winRate} sample={sample} />
          {sample === 0 ? <p className="mt-3 text-xs text-muted">Null until closed trades exist.</p> : null}
        </div>
      </Panel>
      <Panel title="Performance" extra={p.observed === false ? "Marks incomplete" : "Ledger-backed"}>
        <div className="grid gap-4 p-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Profit factor" value={<span className="mono">{p.profitFactor ?? "—"}</span>} hint={sample === 0 ? "Not computable" : undefined} />
          <Metric label="Avg win" value={<span className={cn("mono", signedClass(p.avgWinUsd))}>{formatUsd(p.avgWinUsd)}</span>} />
          <Metric label="Avg loss" value={<span className={cn("mono", signedClass(p.avgLossUsd ? `-${p.avgLossUsd}` : null))}>{p.avgLossUsd ? formatUsd(`-${p.avgLossUsd}`) : "—"}</span>} />
          <Metric label="Expectancy" value={<span className={cn("mono", signedClass(p.expectancyUsd))}>{formatUsd(p.expectancyUsd)}</span>} />
          <Metric label="Largest gain" value={<span className="mono text-profit">{formatUsd(p.largestGainUsd)}</span>} />
          <Metric label="Largest loss" value={<span className="mono text-loss">{formatUsd(p.largestLossUsd)}</span>} />
          <Metric label="Max drawdown (all history)" value={<span className="mono text-loss">{formatDrawdown(p.historicalMaxDrawdownPct ?? p.maxDrawdownPct)}</span>} hint={formatAllHistoryWindow(p.historicalDrawdown?.sampleCount, p.historicalDrawdown?.firstAt)} />
          <Metric label="Fees" value={<span className="mono">{formatUsd(p.feesUsd)}</span>} />
          <Metric label="Avg slippage" value={<span className="mono">{p.avgSlippageBps != null ? `${p.avgSlippageBps} bps` : "—"}</span>} hint={p.fillCount != null ? `${p.fillCount} fills` : undefined} />
          <Metric label="Slippage USD" value={<span className="mono">{formatUsd(p.totalSlippageUsd)}</span>} />
          <Metric label="Return vs baseline" value={<span className={cn("mono", signedClass(p.returnPct))}>{formatPct(p.returnPct)}</span>} hint={`Baseline ${formatUsd(p.startingBalanceUsd)}`} />
          <Metric label="Win rate" value={<span className="mono">{formatRate(p.winRate)}</span>} />
        </div>
        <div className="border-t border-border px-3 py-3">
          <div className="mb-2 text-[10px] uppercase tracking-[0.14em] text-muted">Trade distribution</div>
          {total === 0 ? (
            <EmptyState title="No closed trades" detail="Distribution remains empty until REALIZED_PNL ledger entries exist." />
          ) : (
            <div className="flex h-3 overflow-hidden rounded bg-border">
              <div className="bg-profit" style={{ width: `${(dist.wins / total) * 100}%` }} title={`Wins ${dist.wins}`} />
              <div className="bg-loss" style={{ width: `${(dist.losses / total) * 100}%` }} title={`Losses ${dist.losses}`} />
              <div className="bg-muted/40" style={{ width: `${(dist.breakeven / total) * 100}%` }} title={`Breakeven ${dist.breakeven}`} />
            </div>
          )}
          <div className="mt-2 flex gap-4 text-[11px] text-muted">
            <span>Wins {dist.wins}</span>
            <span>Losses {dist.losses}</span>
            <span>Breakeven {dist.breakeven}</span>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function WinRateRadial({ rate, sample }: { rate: string | null; sample: number }) {
  const pct = rate == null || sample === 0 ? 0 : Math.max(0, Math.min(100, Number(rate) * 100));
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;
  return (
    <div className="relative h-36 w-36">
      <svg viewBox="0 0 140 140" className="h-full w-full -rotate-90">
        <circle cx="70" cy="70" r={radius} fill="none" stroke="#243044" strokeWidth="10" />
        <circle
          cx="70"
          cy="70"
          r={radius}
          fill="none"
          stroke={sample === 0 ? "#243044" : "#35e0c4"}
          strokeWidth="10"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <div className="mono text-xl">{sample === 0 || rate == null ? "—" : `${pct.toFixed(0)}%`}</div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-muted">Win rate</div>
        </div>
      </div>
    </div>
  );
}
