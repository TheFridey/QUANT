"use client";

import { useEffect, useState } from "react";
import { AnimatedValue } from "@/components/terminal/animated-value";
import { EquityChart } from "@/components/terminal/equity-chart";
import { EmptyState, Metric, Panel } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { api } from "@/lib/api";
import { formatDrawdown, formatPct, formatUsd, signedClass } from "@/lib/format";
import type { EquityHistory } from "@/lib/types";
import { cn } from "@/lib/utils";

export function PortfolioSection({ showChart = true }: { showChart?: boolean }) {
  const { snapshot } = useSnapshot();
  const [range, setRange] = useState("24H");
  const [history, setHistory] = useState<EquityHistory | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    if (!showChart) return;
    let cancelled = false;
    api<EquityHistory>(`/terminal/equity?range=${encodeURIComponent(range)}`)
      .then((result) => {
        if (!cancelled) {
          setHistory(result);
          setHistoryError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setHistoryError(caught instanceof Error ? caught.message : "Equity history failed");
      });
    return () => {
      cancelled = true;
    };
  }, [range, showChart, snapshot?.serverTime]);

  if (!snapshot) return null;
  const p = snapshot.portfolio;

  return (
    <div className="space-y-3 animate-odin-fade">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-8">
        <Stat label="Equity" value={p.equityUsd === null ? "Incomplete" : formatUsd(p.equityUsd)} flash />
        <Stat label="Available funds" value={formatUsd(p.availableFundsUsd ?? p.cashUsd)} />
        <Stat label="Realised P&L" value={formatUsd(p.realizedPnlUsd)} className={signedClass(p.realizedPnlUsd)} />
        <Stat
          label="Unrealised P&L"
          value={p.unrealizedPnlUsd === null ? "—" : formatUsd(p.unrealizedPnlUsd)}
          className={signedClass(p.unrealizedPnlUsd)}
        />
        <Stat label="Total return" value={formatPct(p.returnPct)} className={signedClass(p.returnPct)} />
        <Stat label="Exposure" value={formatUsd(p.exposureUsd ?? null)} />
        <Stat
          label="Drawdown (below HWM)"
          value={formatDrawdown(p.currentDrawdownPct ?? p.maxDrawdownPct ?? null)}
          className="text-loss"
        />
        <Stat label="Starting capital" value={formatUsd(p.startingBalanceUsd)} />
      </div>

      {showChart ? (
        <Panel title="Equity curve" extra={historyError ?? undefined} className="min-h-[320px]">
          {historyError ? <EmptyState title="Could not load equity history" detail={historyError} /> : <EquityChart history={history} range={range} onRange={setRange} />}
        </Panel>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  className,
  flash,
}: {
  label: string;
  value: string;
  className?: string;
  flash?: boolean;
}) {
  return (
    <div className="panel rounded-md px-3 py-3">
      <Metric
        label={label}
        value={flash ? <AnimatedValue value={value} className={cn("text-base", className)} /> : <span className={cn("mono text-base", className)}>{value}</span>}
      />
    </div>
  );
}
