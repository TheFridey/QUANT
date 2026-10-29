"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyState, Metric, Panel } from "@/components/terminal/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatUsd } from "@/lib/format";

type CapacityPayload = {
  accountId: string;
  tradingEnvironment: string;
  totals: {
    budgetUsd: string;
    filledCommittedUsd: string;
    pendingCommittedUsd: string;
    availableUsd: string;
  };
  entriesSuspended: boolean;
  safetyStates: Array<{ code: string; activatedAt: string }>;
  instances: Array<{
    id: string;
    name: string;
    status: string;
    moduleRef: string | null;
    budgetUsd: string;
    filledCommittedUsd: string;
    pendingCommittedUsd: string;
    availableUsd: string;
    overCommittedUsd: string;
    allocations: Array<{
      pairAddress: string;
      qty: string;
      reservedExitQty: string;
      committedCapitalUsd: string;
      ownership: string;
    }>;
    waitingIntents: Array<{
      id: string;
      pairAddress: string;
      action: string;
      status: string;
      familyLabel: string | null;
      reasonCodes: string[];
    }>;
  }>;
  netPositions: Array<{
    pairAddress: string;
    baseSymbol: string;
    localQty: string;
    allocatedQty: string;
    unattributedQty: string;
    protection: { status: string; coveredQty: string };
    reconciliation: string;
    owners: Array<{ strategyInstanceId: string; instanceName: string | null; qty: string }>;
  }>;
  recoveryCases: Array<{
    id: string;
    kind: string;
    severity: string;
    pairAddress: string | null;
    detail: unknown;
    createdAt: string;
  }>;
  reconciliation: {
    localAllocation: { status: string; ageMs: number; differenceCount: number } | null;
    broker: { status: string; ageMs: number; complete: boolean } | null;
  };
  notes: { budget: string; available: string };
};

type WhyNoTradesPayload = {
  window: string;
  primary: { id: string; label: string; action: string; basis: string } | null;
  families: Array<{ id: string; label: string; count: number; action: string }>;
  evaluations: number;
  actedEvaluations: number;
  note?: string;
};

export function CapacitySection() {
  const [capacity, setCapacity] = useState<CapacityPayload | null>(null);
  const [why, setWhy] = useState<WhyNoTradesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [budgetDraft, setBudgetDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [cap, noTrades] = await Promise.all([
        api<CapacityPayload>("/terminal/capacity"),
        api<WhyNoTradesPayload>("/terminal/why-no-trades?window=1h"),
      ]);
      setCapacity(cap);
      setWhy(noTrades);
      setError(null);
      setBudgetDraft(Object.fromEntries(cap.instances.map((row) => [row.id, row.budgetUsd])));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Capacity load failed");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function patchInstance(id: string, body: { status?: string; budgetUsd?: string }) {
    setBusyId(id);
    try {
      await api(`/strategy-instances/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Instance update failed");
    } finally {
      setBusyId(null);
    }
  }

  if (error && !capacity) {
    return (
      <Panel title="Capacity & allocations">
        <p className="p-4 text-sm text-loss">{error}</p>
        <div className="px-4 pb-4">
          <Button size="xs" variant="outline" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      </Panel>
    );
  }

  if (!capacity) {
    return (
      <Panel title="Capacity & allocations">
        <p className="p-4 text-xs text-muted">Loading instance budgets and ownership…</p>
      </Panel>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2 animate-odin-fade">
      <Panel title="Account capacity">
        <div className="grid grid-cols-2 gap-4 p-4">
          <Metric label="Budget" value={<span className="mono">{formatUsd(capacity.totals.budgetUsd)}</span>} />
          <Metric label="Available" value={<span className="mono">{formatUsd(capacity.totals.availableUsd)}</span>} />
          <Metric label="Filled committed" value={<span className="mono">{formatUsd(capacity.totals.filledCommittedUsd)}</span>} />
          <Metric label="Pending reserved" value={<span className="mono">{formatUsd(capacity.totals.pendingCommittedUsd)}</span>} />
        </div>
        <p className="border-t border-border/70 px-4 py-2 text-[11px] text-muted">{capacity.notes.available}</p>
        {capacity.entriesSuspended ? (
          <p className="border-t border-border/70 px-4 py-2 text-[11px] text-loss">
            Entries suspended
            {capacity.safetyStates.map((row) => ` · ${row.code}`).join("")}. ACK of alerts does not clear this.
          </p>
        ) : null}
        {error ? <p className="px-4 pb-3 text-[11px] text-loss">{error}</p> : null}
      </Panel>

      <Panel title="Why no trades">
        {why?.primary ? (
          <div className="space-y-2 p-4 text-sm">
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted">Primary · {why.primary.basis}</div>
            <div className="font-medium">{why.primary.label}</div>
            <p className="text-xs text-muted">{why.primary.action}</p>
            <p className="text-[11px] text-muted">
              Window {why.window}: {why.evaluations} evaluations, {why.actedEvaluations} acted
            </p>
          </div>
        ) : (
          <EmptyState title="No decisive block" detail="Recent cycles produced no HOLD/REJECT families in this window." />
        )}
        {(why?.families?.length ?? 0) > 0 ? (
          <ul className="divide-y divide-border/70 border-t border-border/70 text-xs">
            {why!.families.map((family) => (
              <li key={family.id} className="flex items-start justify-between gap-2 px-4 py-2">
                <span>
                  {family.label}
                  <span className="mt-1 block text-[10px] text-muted">{family.action}</span>
                </span>
                <span className="mono text-muted">{family.count}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      <Panel title="Strategy instances" className="lg:col-span-2">
        {capacity.instances.length === 0 ? (
          <EmptyState title="No instances" detail="No strategy instances on this paper account." />
        ) : (
          <ul className="divide-y divide-border/70">
            {capacity.instances.map((row) => (
              <li key={row.id} className="space-y-2 px-4 py-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">{row.name}</div>
                    <div className="mono text-[10px] text-muted">
                      {row.id} · {row.moduleRef ?? "unbound"} · {row.status}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busyId === row.id || row.status === "ACTIVE"}
                      onClick={() => void patchInstance(row.id, { status: "ACTIVE" })}
                    >
                      Resume
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busyId === row.id || row.status === "PAUSED"}
                      onClick={() => void patchInstance(row.id, { status: "PAUSED" })}
                    >
                      Pause
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busyId === row.id || row.status === "DISABLED"}
                      onClick={() => void patchInstance(row.id, { status: "DISABLED" })}
                    >
                      Disable
                    </Button>
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-4">
                  <Metric label="Budget" value={<span className="mono">{formatUsd(row.budgetUsd)}</span>} />
                  <Metric label="Filled" value={<span className="mono">{formatUsd(row.filledCommittedUsd)}</span>} />
                  <Metric label="Pending" value={<span className="mono">{formatUsd(row.pendingCommittedUsd)}</span>} />
                  <Metric label="Available" value={<span className="mono">{formatUsd(row.availableUsd)}</span>} />
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="space-y-1">
                    <span className="text-[10px] uppercase tracking-[0.14em] text-muted">Set budget USD</span>
                    <Input
                      className="h-8 w-36 mono text-xs"
                      value={budgetDraft[row.id] ?? row.budgetUsd}
                      onChange={(event) => setBudgetDraft((prev) => ({ ...prev, [row.id]: event.target.value }))}
                    />
                  </label>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busyId === row.id || (budgetDraft[row.id] ?? "") === row.budgetUsd}
                    onClick={() => void patchInstance(row.id, { budgetUsd: budgetDraft[row.id] })}
                  >
                    Apply budget
                  </Button>
                  {dPositive(row.overCommittedUsd) ? (
                    <span className="text-[10px] text-loss">
                      Over-committed {formatUsd(row.overCommittedUsd)} — lowering budget never sells.
                    </span>
                  ) : null}
                </div>
                {row.waitingIntents.length > 0 ? (
                  <div className="text-[11px] text-muted">
                    Waiting intents:{" "}
                    {row.waitingIntents
                      .map((intent) => `${intent.action}@${intent.pairAddress.slice(0, 8)}… (${intent.familyLabel ?? intent.status})`)
                      .join("; ")}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-border/70 px-4 py-2 text-[11px] text-muted">{capacity.notes.budget}</p>
      </Panel>

      <Panel title="Net positions & ownership" className="lg:col-span-2">
        {capacity.netPositions.length === 0 ? (
          <EmptyState title="Flat book" detail="No open positions on this account." />
        ) : (
          <ul className="divide-y divide-border/70 text-xs">
            {capacity.netPositions.map((row) => (
              <li key={row.pairAddress} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
                <div>
                  <div className="font-medium">
                    {row.baseSymbol} <span className="mono text-muted">{row.pairAddress.slice(0, 12)}…</span>
                  </div>
                  <div className="mt-1 text-muted">
                    local {row.localQty} · allocated {row.allocatedQty} · unattributed {row.unattributedQty}
                  </div>
                  <div className="mt-1 text-[10px] text-muted">
                    {row.owners.map((owner) => `${owner.instanceName ?? owner.strategyInstanceId}:${owner.qty}`).join(" · ") ||
                      "no strategy owners"}
                  </div>
                </div>
                <div className="text-right mono text-[11px]">
                  <div>{row.protection.status}</div>
                  <div className="text-muted">{row.reconciliation}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Recovery & reconcile" className="lg:col-span-2">
        <div className="grid gap-3 p-4 text-xs sm:grid-cols-2">
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted">Local allocation</div>
            <div className="mono mt-1">
              {capacity.reconciliation.localAllocation
                ? `${capacity.reconciliation.localAllocation.status} · drift ${capacity.reconciliation.localAllocation.differenceCount} · age ${Math.round(capacity.reconciliation.localAllocation.ageMs / 1000)}s`
                : "NOT_RUN"}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted">Broker</div>
            <div className="mono mt-1">
              {capacity.reconciliation.broker
                ? `${capacity.reconciliation.broker.status} · complete=${capacity.reconciliation.broker.complete}`
                : "NOT_RUN (no invented CLEAN mirror)"}
            </div>
          </div>
        </div>
        {capacity.recoveryCases.length === 0 ? (
          <p className="border-t border-border/70 px-4 py-3 text-xs text-muted">No open recovery cases.</p>
        ) : (
          <ul className="divide-y divide-border/70 border-t border-border/70 text-xs">
            {capacity.recoveryCases.map((row) => (
              <li key={row.id} className="px-4 py-2">
                <span className="mono">{row.severity}</span> · {row.kind}
                {row.pairAddress ? ` · ${row.pairAddress.slice(0, 12)}…` : ""}
                <span className="mt-1 block text-[10px] text-muted">Blocks resume until resolved · {row.createdAt}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function dPositive(value: string): boolean {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}
