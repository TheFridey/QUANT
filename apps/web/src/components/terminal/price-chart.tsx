"use client";

import { useEffect, useRef } from "react";

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
        layout: { background: { type: ColorType.Solid, color: "#10141c" }, textColor: "#8d97a8", fontFamily: "IBM Plex Mono, ui-monospace, monospace" },
        grid: { vertLines: { color: "#1c2533" }, horzLines: { color: "#1c2533" } },
        rightPriceScale: { borderColor: "#2a3446" },
        timeScale: { borderColor: "#2a3446", timeVisible: true, secondsVisible: false },
      });
      const series = chart.addSeries(LineSeries, { color: "#e4b15a", lineWidth: 2 });
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
    return <div className="flex h-full items-center justify-center text-sm text-muted">No persisted prices for this pair yet.</div>;
  }
  return <div ref={ref} className="h-full min-h-[220px] w-full" />;
}
