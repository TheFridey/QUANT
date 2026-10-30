"use client";

import { useState } from "react";
import { EmptyState, Panel } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatDuration, formatPct, formatPx, formatQty, formatUsd, signedClass } from "@/lib/format";
import type { PositionRow } from "@/lib/types";
import { cn } from "@/lib/utils";

function protectionTone(position: PositionRow): { label: string; className: string } {
  const status = position.protectionStatus;
  if (position.protectionRecoveryNeeded || status === "FAILED") {
    return { label: status === "FAILED" ? "FAILED — recovery needed" : "Recovery needed", className: "text-loss" };
  }
  if (status === "UNPROTECTED" || !position.protected) {
    return { label: "No stop", className: "text-loss" };
  }
  if (status === "EXIT_IN_PROGRESS") {
    return { label: "Exit in progress", className: "text-warning" };
  }
  if (status === "UNKNOWN") {
    return { label: "Stop status unknown", className: "text-warning" };
  }
  if (position.protectionVenueConfirmed) return { label: "Stop confirmed by venue", className: "text-profit" };
  if (position.protectionHelper) return { label: "Stop held by engine", className: "text-foreground" };
  if (position.protectionConfirmed) return { label: "Stop confirmed", className: "text-profit" };
  return { label: "Stop set", className: "text-foreground" };
}

export function PositionsSection() {
  const { snapshot, refresh } = useSnapshot();
  const [closing, setClosing] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (!snapshot) return null;
  const positions = snapshot.portfolio.positions;
  const urgent = positions.filter((row) => row.protectionRecoveryNeeded || row.protectionStatus === "FAILED" || row.protectionStatus === "UNPROTECTED" || !row.protected);
  const canClose = snapshot.engine.status === "RUNNING" || snapshot.engine.status === "PAUSED";

  async function closePosition(pairAddress: string) {
    setClosing(pairAddress);
    setMessage(null);
    const clientIntentId = `intent_sell_${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Date.now()}`;
    try {
      const result = await api<{ pending: boolean; status: string; cycleId: string; error: string | null; message?: string }>(
        "/orders",
        {
          method: "POST",
          body: JSON.stringify({ side: "SELL", pairAddress, clientIntentId }),
        },
      );
      setMessage(result.pending ? `Close accepted · ${result.cycleId}` : result.message ?? result.status);
      await refresh();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Close failed");
    } finally {
      setClosing(null);
    }
  }

  return (
    <div className="grid gap-3 animate-odin-fade">
      {urgent.length > 0 ? (
        <Panel title="Protection exceptions" extra={`${urgent.length} need attention`} className="border-loss/40">
          <ul className="divide-y divide-border/70 text-xs">
            {urgent.map((row) => {
              const tone = protectionTone(row);
              return (
                <li key={`urgent-${row.pairAddress}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                  <div>
                    <div className="font-medium">{row.baseSymbol}</div>
                    <div className={cn("mono text-[11px]", tone.className)}>{tone.label}</div>
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={!canClose || closing === row.pairAddress}
                    onClick={() => void closePosition(row.pairAddress)}
                  >
                    {closing === row.pairAddress ? "Closing…" : "Reduce-only close"}
                  </Button>
                </li>
              );
            })}
          </ul>
        </Panel>
      ) : null}

      <Panel title="Open positions" extra={`${positions.length} open`}>
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {message ?? ""}
        </div>
        {message ? (
          <p role="status" className="border-b border-border px-3 py-2 text-xs text-muted">
            {message}
          </p>
        ) : null}
        {positions.length === 0 ? (
          <EmptyState title="No open paper positions" detail="Positions appear after filled BUY orders on the paper ledger." />
        ) : (
          <div className="overflow-auto">
            <table className="w-full min-w-[980px] text-left text-xs">
              <thead className="sticky top-0 bg-card text-[10px] uppercase tracking-[0.12em] text-muted">
                <tr className="border-b border-border">
                  <th className="px-3 py-2">Token</th>
                  <th className="px-3 py-2">Qty</th>
                  <th className="px-3 py-2">Entry</th>
                  <th className="px-3 py-2">Mark</th>
                  <th className="px-3 py-2">Value</th>
                  <th className="px-3 py-2">uPnL</th>
                  <th className="px-3 py-2">Stop</th>
                  <th className="px-3 py-2">Target</th>
                  <th className="px-3 py-2">Protection</th>
                  <th className="px-3 py-2">Exposure</th>
                  <th className="px-3 py-2">Hold</th>
                  <th className="px-3 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((position) => {
                  const tone = protectionTone(position);
                  return (
                    <tr
                      key={position.pairAddress}
                      className={cn(
                        "border-b border-border/70",
                        position.protectionRecoveryNeeded || position.protectionStatus === "FAILED" ? "bg-loss/5" : null,
                      )}
                    >
                      <td className="px-3 py-2">
                        <div>{position.baseSymbol}</div>
                        <div className="text-[10px] text-muted">
                          {position.markState}
                          {position.paperFamily ? ` · ${position.paperFamily}` : ""}
                        </div>
                        {position.productLabel ? (
                          <div className="text-[10px] text-muted truncate max-w-[160px]">{position.productLabel}</div>
                        ) : null}
                        {position.sessionStatus ? (
                          <div className="text-[10px] text-muted">
                            Session {position.sessionStatus}
                            {position.sessionReason ? ` (${position.sessionReason})` : ""}
                          </div>
                        ) : null}
                      </td>
                      <td className="mono px-3 py-2">{formatQty(position.baseQty)}</td>
                      <td className="mono px-3 py-2">{formatPx(position.avgCostUsd)}</td>
                      <td className="mono px-3 py-2">{formatPx(position.markUsd)}</td>
                      <td className="mono px-3 py-2">{formatUsd(position.marketValueUsd)}</td>
                      <td className={cn("mono px-3 py-2", signedClass(position.unrealizedPnlUsd))}>
                        {formatUsd(position.unrealizedPnlUsd)}
                      </td>
                      <td className="mono px-3 py-2">{formatPx(position.stopUsd)}</td>
                      <td className="mono px-3 py-2">{formatPx(position.targetUsd)}</td>
                      <td className="px-3 py-2 text-[11px]">
                        <span className={cn("font-medium", tone.className)}>{tone.label}</span>
                        <span className="block text-[10px] text-muted">
                          {(position.protectionKinds ?? []).join("/") || "—"} ·{" "}
                          {position.protectionOrigin === "VENUE_NATIVE" ? "venue" : position.protectionOrigin === "SYNTHETIC_ENGINE" ? "engine" : "—"} ·{" "}
                          {position.protectionAckState ?? "—"}
                          {position.protectionDesireDiverges ? " · desire≠confirmed" : ""}
                          {position.protectionRecoveryNeeded ? " · recoveryNeeded" : ""}
                        </span>
                      </td>
                      <td className="mono px-3 py-2">{formatPct(position.exposurePct)}</td>
                      <td className="mono px-3 py-2">{formatDuration(position.openedAt)}</td>
                      <td className="px-3 py-2">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={!canClose || closing === position.pairAddress}
                          onClick={() => void closePosition(position.pairAddress)}
                        >
                          {closing === position.pairAddress ? "…" : "Close"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
