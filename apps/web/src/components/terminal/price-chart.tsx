"use client";

import { useEffect, useRef } from "react";
import { EmptyState } from "@/components/terminal/panel";

export function PriceChart({ points }: { points: Array<{ time: number; priceUsd: string }> }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || points.length === 0) return;
    let disposed = false;
    let remove = (): void => undefined;
    void import("lightweight-charts").then(({ createChart, ColorType, LineSeries }) => {
      if (disposed || !ref.current) return;
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
      });
      const series = chart.addSeries(LineSeries, { color: "#7eb6ff", lineWidth: 2 });
      series.setData(points.map((point) => ({ time: point.time as never, value: Number(point.priceUsd) })));
      chart.timeScale().fitContent();
      remove = () => chart.remove();
    });
    return () => {
      disposed = true;
      remove();
    };
  }, [points]);

  if (points.length === 0) {
    return <EmptyState title="No persisted prices" detail="Waiting for DexScreener observations for this pair." />;
  }
  return <div ref={ref} className="h-full min-h-[220px] w-full" />;
}
