"use client";

import { useState } from "react";
import { EmptyState, Panel } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { estimateTicket } from "@/lib/estimates";
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
  // UI item 11: every close goes through a confirmation that shows the estimate first.
  const [confirming, setConfirming] = useState<string[] | null>(null);
  if (!snapshot) return null;
  const positions = snapshot.portfolio.positions;
  const urgent = positions.filter((row) => row.protectionRecoveryNeeded || row.protectionStatus === "FAILED" || row.protectionStatus === "UNPROTECTED" || !row.protected);
  const canClose = snapshot.engine.status === "RUNNING" || snapshot.engine.status === "PAUSED";

  const config = snapshot.engine.config;
  const estimates = (pairs: string[]) =>
    pairs.map((pairAddress) => {
      const row = positions.find((item) => item.pairAddress === pairAddress);
      const quote = snapshot.market.pairs.find((item) => item.pairAddress === pairAddress);
      const priceUsd = Number(quote?.priceUsd ?? row?.markUsd ?? 0);
      const estimate =
        row && priceUsd > 0
          ? estimateTicket({
              side: "SELL",
              priceUsd,
              qty: Number(row.baseQty),
              liquidityUsd: quote?.liquidityUsd ? Number(quote.liquidityUsd) : null,
              feeBps: Number(config?.feeBps ?? 30),
              spreadBps: Number(config?.spreadBpsEstimate ?? 5),
              stopLossPct: 0,
              exposureUsd: null,
            })
          : null;
      return { pairAddress, symbol: row?.baseSymbol ?? pairAddress, estimate };
    });

  async function closeConfirmed(pairs: string[]) {
    setConfirming(null);
    for (const pairAddress of pairs) await closePosition(pairAddress);
  }

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
                    onClick={() => setConfirming([row.pairAddress])}
                  >
                    {closing === row.pairAddress ? "Closing…" : "Close"}
                  </Button>
                </li>
              );
            })}
          </ul>
        </Panel>
      ) : null}

      <Panel
        title="Open positions"
        extra={
          <span className="flex items-center gap-2">
            {positions.length} open
            {positions.length > 1 ? (
              <Button type="button" size="xs" variant="outline" disabled={!canClose || closing !== null} onClick={() => setConfirming(positions.map((row) => row.pairAddress))}>
                Close all
              </Button>
            ) : null}
          </span>
        }
      >
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
                        <span
                          className="block text-[10px] text-muted"
                          title={[
                            (position.protectionKinds ?? []).join("/") || "no legs",
                            position.protectionOrigin ?? "",
                            position.protectionAckState ?? "",
                            position.protectionDesireDiverges ? "DESIRE_DIVERGES" : "",
                            position.protectionRecoveryNeeded ? "RECOVERY_NEEDED" : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        >
                          {position.protectionOrigin === "VENUE_NATIVE" ? "Held at venue" : position.protectionOrigin === "SYNTHETIC_ENGINE" ? "Held by engine" : ""}
                          {position.protectionRecoveryNeeded ? " · needs recovery" : ""}
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
                          onClick={() => setConfirming([position.pairAddress])}
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

      <Dialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent>
          <DialogTitle>{confirming && confirming.length > 1 ? `Close all ${confirming.length} positions` : "Close position"}</DialogTitle>
          <DialogDescription className="text-sm text-muted">
            Sells at the next eligible quote. Figures are estimates; the engine prices the fill itself.
          </DialogDescription>
          {confirming ? (
            <table className="mt-3 w-full text-xs">
              <thead className="text-left text-muted">
                <tr>
                  <th className="font-normal">Position</th>
                  <th className="font-normal text-right">Est. slippage</th>
                  <th className="font-normal text-right">Est. proceeds</th>
                </tr>
              </thead>
              <tbody>
                {estimates(confirming).map((row) => (
                  <tr key={row.pairAddress}>
                    <td>{row.symbol}</td>
                    <td className="mono text-right">
                      {row.estimate?.impactBps != null ? `${row.estimate.impactBps.toFixed(0)} bps` : "—"}
                    </td>
                    <td className="mono text-right">{row.estimate?.proceedsUsd != null ? formatUsd(row.estimate.proceedsUsd.toFixed(2)) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button type="button" size="sm" variant="danger" onClick={() => confirming && void closeConfirmed(confirming)}>
              Confirm close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
