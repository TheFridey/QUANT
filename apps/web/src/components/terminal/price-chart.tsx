"use client";

import { useEffect, useRef } from "react";
import { EmptyState } from "@/components/terminal/panel";

export type ChartPoint = { time: number; priceUsd: string; volumeUsd?: string | null };
export type ChartLevels = { entryUsd?: string | null; stopUsd?: string | null; targetUsd?: string | null };

const LONDON_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
const LONDON_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "2-digit", month: "short" });

/**
 * UI item 10: price with 5-minute volume beneath it, the open position's entry, stop and target as
 * price lines, and time labels in London time without repeats (day shown only when it changes).
 */
export function PriceChart({ points, levels }: { points: ChartPoint[]; levels?: ChartLevels }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || points.length === 0) return;
    let disposed = false;
    let remove = (): void => undefined;
    void import("lightweight-charts").then(({ createChart, ColorType, LineSeries, HistogramSeries, LineStyle, TickMarkType }) => {
      if (disposed || !ref.current) return;
      const chart = createChart(ref.current, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: "#111927" },
          textColor: "#8b9bb3",
          fontFamily: "JetBrains Mono, ui-monospace, monospace",
        },
        grid: { vertLines: { color: "#1a2436" }, horzLines: { color: "#1a2436" } },
        rightPriceScale: { borderColor: "#243044", scaleMargins: { top: 0.08, bottom: 0.28 } },
        timeScale: {
          borderColor: "#243044",
          timeVisible: true,
          secondsVisible: false,
          // One label per tick type: day names only on day boundaries, so times do not repeat.
          tickMarkFormatter: (time: number, type: number) => {
            const date = new Date(time * 1000);
            return type === TickMarkType.DayOfMonth || type === TickMarkType.Month || type === TickMarkType.Year
              ? LONDON_DAY.format(date)
              : LONDON_TIME.format(date);
          },
        },
        localization: { timeFormatter: (time: number) => `${LONDON_DAY.format(new Date(time * 1000))} ${LONDON_TIME.format(new Date(time * 1000))}` },
      });
      const series = chart.addSeries(LineSeries, { color: "#7eb6ff", lineWidth: 2 });
      series.setData(points.map((point) => ({ time: point.time as never, value: Number(point.priceUsd) })));

      const volumePoints = points.filter((point) => point.volumeUsd != null && Number(point.volumeUsd) >= 0);
      if (volumePoints.length > 0) {
        const volume = chart.addSeries(HistogramSeries, { color: "#2a3b55", priceScaleId: "volume", priceFormat: { type: "volume" } });
        chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
        volume.setData(volumePoints.map((point) => ({ time: point.time as never, value: Number(point.volumeUsd) })));
      }

      const lines: Array<[string | null | undefined, string, string]> = [
        [levels?.entryUsd, "#c9d4e5", "Entry"],
        [levels?.stopUsd, "#f36b7c", "Stop"],
        [levels?.targetUsd, "#35e0c4", "Target"],
      ];
      for (const [price, color, title] of lines) {
        if (price && Number(price) > 0) {
          series.createPriceLine({ price: Number(price), color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title });
        }
      }
      chart.timeScale().fitContent();
      remove = () => chart.remove();
    });
    return () => {
      disposed = true;
      remove();
    };
  }, [points, levels?.entryUsd, levels?.stopUsd, levels?.targetUsd]);

  if (points.length === 0) {
    return <EmptyState title="No prices yet" detail="Waiting for market observations for this pair." />;
  }
  return <div ref={ref} className="h-full min-h-[220px] w-full" role="figure" aria-label="Price and volume chart" />;
}
