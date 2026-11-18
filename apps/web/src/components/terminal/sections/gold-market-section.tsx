"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, Panel } from "@/components/terminal/panel";
import { api } from "@/lib/api";

/**
 * HELIOS: AURUM COMMAND first market view. Genuine XAU_USD warehouse bars only; no synthetic candles, no live
 * price while the shadow feed is inactive, no account, no executable ticket.
 */

type Dataset = {
  id: string;
  sourceId: string;
  instrumentKey: string;
  interval: string;
  alignment: "UTC" | "NEW_YORK_17";
  barCount: number;
  firstOpenTime: string | null;
  lastOpenTime: string | null;
  versionHash: string | null;
  updatedAt: string;
};
type Candle = { t: number; o: string; h: string; l: string; c: string; bidC: string | null; askC: string | null; spreadC: string | null };
type CandleResponse = { dataset: Dataset; candles: Candle[]; gaps: Array<{ afterT: number; beforeT: number; missingBars: number }>; bidAskCoverage: number | null };
type Status = {
  legacyCrypto: { mode: "ACTIVE" | "RETIRED" };
  shadowFeed: { state: string; persisted: boolean; reason: string };
  account: { state: string };
  execution: { state: string; reason: string };
  research: { state: string; reason: string };
};

const GOLD = "#c9a24b";
const INTERVAL_ORDER = ["1m", "5m", "15m", "1h", "4h", "1d"];

function utc(iso: string | null): string {
  return iso ? `${iso.replace("T", " ").slice(0, 16)} UTC` : "—";
}

function ageText(iso: string | null): string {
  if (!iso) return "—";
  const h = (Date.now() - Date.parse(iso)) / 3_600_000;
  return h < 48 ? `${h.toFixed(1)} h old` : `${(h / 24).toFixed(1)} days old`;
}

function StatusChip({ label, value, tone }: { label: string; value: string; tone: "ok" | "off" | "block" }) {
  const color = tone === "ok" ? "text-emerald-300 border-emerald-500/30" : tone === "block" ? "text-red-300 border-red-500/30" : "text-[#d9c28a] border-[#c9a24b]/30";
  return (
    <div className={`rounded-md border bg-[#111214] px-3 py-2 ${color}`} data-testid={`gold-status-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted">{label}</p>
      <p className="mono text-sm">{value}</p>
    </div>
  );
}

function CandleChart({ candles }: { candles: Candle[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current || candles.length === 0) return;
    let remove = () => {};
    let cancelled = false;
    void import("lightweight-charts").then(({ createChart, ColorType, CandlestickSeries }) => {
      if (cancelled || !ref.current) return;
      const chart = createChart(ref.current, {
        autoSize: true,
        layout: { background: { type: ColorType.Solid, color: "#0d0e10" }, textColor: "#a8a29a", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
        grid: { vertLines: { color: "#1c1d20" }, horzLines: { color: "#1c1d20" } },
        rightPriceScale: { borderColor: "#2a2b2f" },
        timeScale: { borderColor: "#2a2b2f", timeVisible: true, secondsVisible: false },
        localization: { timeFormatter: (t: number) => new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC" },
      });
      const series = chart.addSeries(CandlestickSeries, {
        upColor: GOLD,
        borderUpColor: GOLD,
        wickUpColor: GOLD,
        downColor: "#3b3d42",
        borderDownColor: "#8a8d94",
        wickDownColor: "#8a8d94",
      });
      series.setData(candles.map((c) => ({ time: Math.floor(c.t / 1000) as never, open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c) })));
      chart.timeScale().fitContent();
      remove = () => chart.remove();
    });
    return () => {
      cancelled = true;
      remove();
    };
  }, [candles]);
  return <div ref={ref} className="h-[420px] w-full" role="img" aria-label="XAU/USD historical candlestick chart (warehouse bars, UTC)" data-testid="gold-candle-chart" />;
}

export function GoldMarketSection() {
  const [status, setStatus] = useState<Status | null>(null);
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [data, setData] = useState<CandleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<Status>("/api/aurum/market/status").then(setStatus).catch((e: unknown) => setError(e instanceof Error ? e.message : "status unavailable"));
    void api<{ datasets: Dataset[] }>("/api/aurum/market/datasets")
      .then((r) => {
        const sorted = [...r.datasets].sort((a, b) => INTERVAL_ORDER.indexOf(a.interval) - INTERVAL_ORDER.indexOf(b.interval));
        setDatasets(sorted);
        const preferred = sorted.find((d) => d.interval === "1h") ?? sorted[0];
        setSelected(preferred?.id ?? null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "datasets unavailable"));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setData(null);
    void api<CandleResponse>(`/api/aurum/market/candles?datasetId=${encodeURIComponent(selected)}&limit=500`)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "candles unavailable"));
  }, [selected]);

  const last = data?.candles.at(-1) ?? null;
  const closedGaps = useMemo(() => data?.gaps.filter((g) => g.missingBars > 0).length ?? 0, [data]);

  return (
    <div className="space-y-3" data-testid="gold-market-section">
      <Panel title="AURUM · Gold market (XAU/USD)" extra={<span className="mono text-[11px] text-[#d9c28a]">PAPER ONLY · NOT EXECUTABLE</span>}>
        <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatusChip label="Legacy crypto" value={status?.legacyCrypto.mode ?? "…"} tone={status?.legacyCrypto.mode === "RETIRED" ? "off" : "ok"} />
          <StatusChip label="Shadow feed" value={status?.shadowFeed.state ?? "…"} tone="off" />
          <StatusChip label="AURUM account" value={status?.account.state ?? "…"} tone="off" />
          <StatusChip label="Execution" value={status?.execution.state ?? "…"} tone="block" />
          <StatusChip label="Research" value={status?.research.state ?? "…"} tone="block" />
          <StatusChip label="Quotes" value="NON-EXECUTABLE" tone="block" />
        </div>
        <p className="px-3 pb-3 text-xs text-muted">
          {status ? `${status.shadowFeed.reason} ${status.execution.reason}` : "Loading programme status…"}
        </p>
      </Panel>

      <Panel title="Reference quote">
        <div className="p-3 text-sm">
          <p className="text-foreground/90">No live reference quote: the gold shadow feed is not active in production.</p>
          <p className="mt-1 text-xs text-muted">
            Bid, ask, spread and quote age appear here once the persistent shadow feed is approved and activated. The chart below is historical warehouse data, not a live price.
          </p>
          {last ? (
            <p className="mono mt-2 text-xs text-[#d9c28a]">
              Last warehouse bar (historical): close {last.c}
              {last.bidC && last.askC ? ` · bid ${last.bidC} · ask ${last.askC} · spread ${last.spreadC ?? "—"}` : " · bid/ask not stored for this dataset"} · opened {utc(new Date(last.t).toISOString())}
            </p>
          ) : null}
        </div>
      </Panel>

      <Panel
        title="Historical chart"
        extra={
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Dataset and timeframe">
            {(datasets ?? []).map((d) => (
              <button
                key={d.id}
                type="button"
                role="tab"
                aria-selected={d.id === selected}
                onClick={() => setSelected(d.id)}
                className={`mono rounded border px-2 py-0.5 text-[11px] ${d.id === selected ? "border-[#c9a24b] text-[#e8d6a6]" : "border-[#2a2b2f] text-muted hover:text-foreground"}`}
              >
                {d.interval}
                {d.alignment === "NEW_YORK_17" ? " NY17" : ""}
              </button>
            ))}
          </div>
        }
      >
        {error ? <EmptyState title="Market data unavailable" detail={error} /> : null}
        {datasets && datasets.length === 0 ? <EmptyState title="No gold datasets in the warehouse" detail="Nothing is drawn rather than inventing candles." /> : null}
        {data && data.candles.length > 0 ? <CandleChart candles={data.candles} /> : data ? <EmptyState title="This dataset has no bars" /> : null}
        {data ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 p-3 text-xs sm:grid-cols-4" data-testid="gold-dataset-meta">
            <div><dt className="text-muted">Source</dt><dd className="mono">{data.dataset.sourceId} · {data.dataset.instrumentKey}</dd></div>
            <div><dt className="text-muted">Interval · alignment</dt><dd className="mono">{data.dataset.interval} · {datasets?.find((d) => d.id === data.dataset.id)?.alignment ?? "UTC"}</dd></div>
            <div><dt className="text-muted">Dataset range</dt><dd className="mono">{utc(data.dataset.firstOpenTime)} → {utc(data.dataset.lastOpenTime)}</dd></div>
            <div><dt className="text-muted">Freshness</dt><dd className="mono">last bar {ageText(data.dataset.lastOpenTime)}</dd></div>
            <div><dt className="text-muted">Bars (dataset / shown)</dt><dd className="mono">{data.dataset.barCount.toLocaleString("en-GB")} / {data.candles.length}</dd></div>
            <div><dt className="text-muted">Gaps in view</dt><dd className="mono">{closedGaps} (includes daily breaks and weekends)</dd></div>
            <div><dt className="text-muted">Bid/ask stored</dt><dd className="mono">{data.bidAskCoverage === null ? "—" : `${Math.round(data.bidAskCoverage * 100)}% of bars`}</dd></div>
            <div><dt className="text-muted">Version hash</dt><dd className="mono truncate" title={data.dataset.versionHash ?? ""}>{data.dataset.versionHash?.slice(0, 16) ?? "—"}</dd></div>
          </dl>
        ) : null}
        <p className="px-3 pb-3 text-[11px] text-muted">Times are UTC. Candles are mid-price OHLC from the OANDA practice warehouse; they are not a tick record.</p>
      </Panel>
    </div>
  );
}
