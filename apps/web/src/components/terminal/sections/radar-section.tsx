"use client";

import { useMemo, useState } from "react";
import { EmptyState, Panel } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatAge, formatLondonDateTime, formatPct, formatPx, formatUsdCompact, signedClass } from "@/lib/format";
import type { WatchlistRow } from "@/lib/types";
import { cn } from "@/lib/utils";

export function RadarSection() {
  const { snapshot } = useSnapshot();
  const [query, setQuery] = useState("");
  const [minLiq, setMinLiq] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  if (!snapshot) return null;

  const rows = useMemo(() => {
    const list = snapshot.watchlist ?? [];
    return list.filter((row) => {
      const q = query.trim().toLowerCase();
      if (q && !`${row.baseSymbol} ${row.quoteSymbol} ${row.dexId}`.toLowerCase().includes(q)) return false;
      if (minLiq) {
        const liq = Number(row.liquidityUsd ?? 0);
        if (!Number.isFinite(liq) || liq < Number(minLiq)) return false;
      }
      return true;
    });
  }, [snapshot.watchlist, query, minLiq]);

  const detail = rows.find((row) => row.pairAddress === selected) ?? rows[0] ?? null;

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px] animate-odin-fade">
      <Panel
        title="Market radar"
        extra={`${rows.length} ranked`}
        bodyClassName="flex flex-col"
      >
        <div className="flex flex-wrap gap-2 border-b border-border p-3">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter symbol / dex"
            className="max-w-xs"
          />
          <Input
            value={minLiq}
            onChange={(event) => setMinLiq(event.target.value)}
            placeholder="Min liquidity USD"
            className="max-w-[160px]"
            inputMode="decimal"
          />
        </div>
        {rows.length === 0 ? (
          <EmptyState title="Watchlist empty" detail="No WatchlistEntry rows yet, or filters excluded all tokens." />
        ) : (
          <div className="overflow-auto" role="region" aria-label="Scrollable table" tabIndex={0}>
            <table className="w-full min-w-[960px] text-left text-xs">
              <thead className="sticky top-0 bg-card text-[10px] uppercase tracking-[0.12em] text-muted">
                <tr className="border-b border-border">
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Token</th>
                  <th className="px-3 py-2">Age</th>
                  <th className="px-3 py-2">Price</th>
                  <th className="px-3 py-2">Liquidity</th>
                  <th className="px-3 py-2">Volume</th>
                  <th className="px-3 py-2">Momentum</th>
                  <th className="px-3 py-2">Security</th>
                  <th className="px-3 py-2">Agent</th>
                  <th className="px-3 py-2">Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.pairAddress}
                    className={cn(
                      "cursor-pointer border-b border-border/70 hover:bg-white/[0.02]",
                      detail?.pairAddress === row.pairAddress && "bg-white/[0.03]",
                    )}
                    onClick={() => setSelected(row.pairAddress)}
                  >
                    <td className="mono px-3 py-2 text-muted">{row.rank}</td>
                    <td className="px-3 py-2">
                      <div>{row.baseSymbol}</div>
                      <div className="text-[10px] text-muted">
                        {row.quoteSymbol} · {row.dexId}
                      </div>
                    </td>
                    <td className="mono px-3 py-2">{formatAge(row.ageMs)}</td>
                    <td className="mono px-3 py-2">{formatPx(row.priceUsd)}</td>
                    <td className="mono px-3 py-2">{formatUsdCompact(row.liquidityUsd)}</td>
                    <td className="mono px-3 py-2">{formatUsdCompact(row.volume24hUsd)}</td>
                    <td className={cn("mono px-3 py-2", signedClass(row.momentumPct))}>{formatPct(row.momentumPct)}</td>
                    <td className="px-3 py-2">
                      {row.security ? (
                        <Badge className={securityClass(row.security.category)}>{row.security.category}</Badge>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {row.recommendation ? (
                        <span>
                          {row.recommendation.agent} · {row.recommendation.decision}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="mono px-3 py-2 text-muted">{formatLondonDateTime(row.lastUpdated ?? row.observedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <DetailCard row={detail} />
    </div>
  );
}

function DetailCard({ row }: { row: WatchlistRow | null }) {
  if (!row) {
    return (
      <Panel title="Token detail">
        <EmptyState title="Select a watchlist row" />
      </Panel>
    );
  }
  return (
    <Panel title={`${row.baseSymbol} / ${row.quoteSymbol}`} extra={`score ${row.score}`}>
      <div className="space-y-3 p-3 text-sm">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-muted">Liquidity</div>
            <div className="mono">{formatUsdCompact(row.liquidityUsd)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-muted">24h volume</div>
            <div className="mono">{formatUsdCompact(row.volume24hUsd)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-muted">Momentum 5m</div>
            <div className={cn("mono", signedClass(row.momentumPct))}>{formatPct(row.momentumPct)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-muted">Freshness</div>
            <div>{row.freshness ?? "—"}</div>
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-muted">Pair</div>
          <div className="mono break-all text-xs text-muted">{row.pairAddress}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-muted">Reasons</div>
          <ul className="mt-1 space-y-1 text-xs text-muted">
            {row.reasonCodes.map((code) => (
              <li key={code}>· {code}</li>
            ))}
          </ul>
        </div>
        {row.security ? (
          <div className="rounded border border-border p-2 text-xs">
            <div className="mb-1 flex items-center gap-2">
              <Badge className={securityClass(row.security.category)}>{row.security.category}</Badge>
              {row.security.stale ? <span className="text-warning">stale</span> : null}
            </div>
            <div className="text-muted">Mint {row.security.mintAuthority}</div>
            <div className="text-muted">Freeze {row.security.freezeAuthority}</div>
            <div className="mt-1 text-muted">{row.security.reasonCodes.join(" · ") || "No security reason codes"}</div>
          </div>
        ) : (
          <p className="text-xs text-muted">No SecurityAssessment persisted for this token.</p>
        )}
      </div>
    </Panel>
  );
}

function securityClass(category: string) {
  const upper = category.toUpperCase();
  if (upper.includes("PASS") || upper.includes("CLEAR") || upper.includes("LOW")) return "border-profit/40 text-profit";
  if (upper.includes("BLOCK") || upper.includes("HIGH") || upper.includes("FAIL")) return "border-loss/40 text-loss";
  return "border-warning/40 text-warning";
}
