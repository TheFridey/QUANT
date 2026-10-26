"use client";

import { useEffect, useRef } from "react";
import type { EquityHistory } from "@/lib/types";
import { EmptyState } from "@/components/terminal/panel";

export function EquityChart({
  history,
  range,
  onRange,
}: {
  history: EquityHistory | null;
  range: string;
  onRange: (range: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const ranges = ["1H", "24H", "7D", "30D", "ALL"];

  useEffect(() => {
    const element = ref.current;
    if (!element || !history || history.insufficientHistory) return;
    const priced = history.points.filter((point) => point.equityUsd !== null);
    if (priced.length < 2) return;
    let disposed = false;
    let remove = (): void => undefined;
    void import("lightweight-charts").then((mod) => {
      if (disposed || !ref.current) return;
      const { createChart, ColorType, LineSeries } = mod;
      const chart = createChart(ref.current, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: "#111927" },
          textColor: "#8b9bb3",
          fontFamily: "JetBrains Mono, ui-monospace, monospace",
        },
        grid: { vertLines: { color: "#1a2436" }, horzLines: { color: "#1a2436" } },
        rightPriceScale: { borderColor: "#243044" },
        timeScale: { borderColor: "#243044", timeVisible: true, secondsVisible: false },
        crosshair: { vertLine: { color: "#243044" }, horzLine: { color: "#243044" } },
      });
      const equity = chart.addSeries(LineSeries, { color: "#35e0c4", lineWidth: 2, priceLineVisible: false });
      equity.setData(priced.map((point) => ({ time: point.time as never, value: Number(point.equityUsd) })));

      if (history.startingBalanceUsd) {
        const baseline = chart.addSeries(LineSeries, {
          color: "#7eb6ff",
          lineWidth: 1,
          lineStyle: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        baseline.setData(
          priced.map((point) => ({ time: point.time as never, value: Number(history.startingBalanceUsd) })),
        );
      }

      const markers = history.markers.slice(-24).map((marker) => ({
        time: marker.time as never,
        position: marker.side === "BUY" ? ("belowBar" as const) : ("aboveBar" as const),
        color: marker.side === "BUY" ? "#35e0c4" : "#f36b7c",
        shape: marker.side === "BUY" ? ("arrowUp" as const) : ("arrowDown" as const),
        text: marker.side === "BUY" ? "B" : "S",
      }));
      const createSeriesMarkers = (mod as { createSeriesMarkers?: (series: unknown, markers: unknown[]) => void }).createSeriesMarkers;
      if (markers.length > 0 && typeof createSeriesMarkers === "function") {
        createSeriesMarkers(equity, markers);
      }

      chart.timeScale().fitContent();
      remove = () => chart.remove();
    });
    return () => {
      disposed = true;
      remove();
    };
  }, [history]);

  return (
    <div className="flex h-full min-h-[280px] flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2">
        {ranges.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => onRange(item)}
            className={`rounded px-2 py-1 text-[11px] ${range === item ? "bg-white/5 text-foreground" : "text-muted hover:text-foreground"}`}
          >
            {item}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-muted">
          {history
            ? history.insufficientHistory
              ? "Insufficient equity history"
              : `${history.pricedPointCount} priced snapshots`
            : "Loading…"}
        </span>
      </div>
      {!history || history.insufficientHistory ? (
        <EmptyState
          title="Equity curve unavailable"
          detail="Need at least two EquitySnapshot rows with priced equity from the ledger/worker."
        />
      ) : (
        <div ref={ref} className="min-h-0 flex-1" />
      )}
    </div>
  );
}
