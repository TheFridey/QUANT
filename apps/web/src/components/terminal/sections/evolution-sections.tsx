"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyState, Panel } from "@/components/terminal/panel";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

type MarketRow = {
  id: string;
  symbol: string;
  displayName: string;
  assetClass: string;
  venue: string;
  enabled: boolean;
  executionCapabilities: string[];
  notes: string | null;
  quote: {
    level: string | null;
    dataState: string;
    provenance: string;
  } | null;
};

export function MarketSelectorSection() {
  const [markets, setMarkets] = useState<MarketRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await api<{ instruments: MarketRow[] }>("/evolution/markets");
    setMarkets(data.instruments);
  }, []);

  useEffect(() => {
    void load().catch((error: unknown) =>
      setMessage(error instanceof Error ? error.message : "Failed to load markets"),
    );
  }, [load]);

  async function toggle(instrumentId: string, enabled: boolean) {
    setMessage(null);
    try {
      await api("/evolution/markets", {
        method: "POST",
        body: JSON.stringify({ instrumentId, enabled }),
      });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Toggle failed");
    }
  }

  return (
    <div className="space-y-3 animate-odin-fade">
      <Panel title="Market Selector" extra="Solana paper + equity indices (research-only)">
        {markets.length === 0 ? (
          <EmptyState title="No instruments" detail={message ?? "Registry empty or API unavailable"} />
        ) : (
          <ul className="divide-y divide-border">
            {markets.map((market) => (
              <li key={market.id} className="flex flex-wrap items-start justify-between gap-3 px-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {market.symbol}{" "}
                    <span className="text-xs text-muted">{market.displayName}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-muted">
                    {market.assetClass} · {market.venue} · {market.executionCapabilities.join(", ")}
                  </div>
                  {market.quote ? (
                    <div className="mt-1 mono text-[11px]">
                      level={market.quote.level ?? "null"} · {market.quote.dataState} · {market.quote.provenance}
                    </div>
                  ) : null}
                  {market.notes ? <p className="mt-1 text-[11px] text-muted">{market.notes}</p> : null}
                </div>
                <Button
                  size="xs"
                  variant={market.enabled ? "default" : "outline"}
                  onClick={() => void toggle(market.id, !market.enabled)}
                >
                  {market.enabled ? "Enabled" : "Disabled"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {message ? <p className="text-xs text-loss">{message}</p> : null}
    </div>
  );
}

export function ResearchCentreSection() {
  const [data, setData] = useState<{
    hypotheses: Array<{ id: string; title: string; status: string; market: string }>;
    queue: Array<{ id: string; kind: string; priority: number; status: string; reason: string }>;
    reports: Array<{ id: string; contentHash: string; approvalStatus: string }>;
    briefing: string;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setData(await api("/evolution/research"));
  }, []);

  useEffect(() => {
    void load().catch((error: unknown) =>
      setMessage(error instanceof Error ? error.message : "Failed to load research centre"),
    );
  }, [load]);

  async function seedHypothesisAndRun() {
    setBusy(true);
    setMessage(null);
    try {
      const hyp = await api<{ id: string }>("/evolution/hypotheses", {
        method: "POST",
        body: JSON.stringify({
          title: "Desk M5 continuation packaging",
          market: "SPOT_CRYPTO_PAIR",
          instrumentIds: ["solana:spot:universe"],
          conditions: "LIVE liquid Solana pairs with WSOL/USDC quote",
          claimedAdvantage: "Short-horizon continuation after orderly M5 thrust",
          entryRules: "M5 in configured band; H1 non-negative; buys>sells",
          exitRules: "Stop, take-profit, or M5 fade",
          riskRules: "ATLAS institutional caps; delayed entries blocked",
          rationale: "Research packaging of existing paper pulse rule",
          successCriteria: "OOS sample and drawdown gates before paper candidate",
          failureModes: "Regime change, liquidity gaps, cost underestimation",
        }),
      });
      const pipeline = await api<{ acceptance: Record<string, string>; lifecycle: string }>(
        "/evolution/pipeline",
        { method: "POST", body: JSON.stringify({ hypothesisId: hyp.id }) },
      );
      setMessage(`Pipeline → ${pipeline.lifecycle}; acceptance recorded.`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Pipeline failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2 animate-odin-fade">
      <Panel
        title="AI Research Centre"
        extra={
          <Button size="xs" disabled={busy} onClick={() => void seedHypothesisAndRun()}>
            {busy ? "Running…" : "Hypothesise + pipeline"}
          </Button>
        }
      >
        {!data ? (
          <EmptyState title="Loading research state" detail={message ?? undefined} />
        ) : (
          <div className="space-y-3 p-3 text-sm">
            <div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted">Hypotheses</div>
              <ul className="mt-1 space-y-1">
                {data.hypotheses.slice(0, 8).map((hyp) => (
                  <li key={hyp.id} className="flex justify-between gap-2">
                    <span className="truncate">{hyp.title}</span>
                    <span className="mono text-[11px] text-muted">{hyp.status}</span>
                  </li>
                ))}
                {data.hypotheses.length === 0 ? <li className="text-muted">None yet</li> : null}
              </ul>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted">ORACLE queue</div>
              <ul className="mt-1 space-y-1">
                {data.queue.slice(0, 8).map((item) => (
                  <li key={item.id} className="text-xs">
                    <span className="mono">P{item.priority}</span> {item.kind} · {item.status} — {item.reason}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Panel>
      <Panel title="Daily briefing / reports">
        <pre className="whitespace-pre-wrap p-3 text-[11px] text-muted">{data?.briefing ?? "—"}</pre>
        <ul className="border-t border-border px-3 py-2 text-xs">
          {(data?.reports ?? []).map((report) => (
            <li key={report.id} className="flex justify-between gap-2 py-1">
              <span className="mono truncate">{report.contentHash.slice(0, 16)}…</span>
              <span>{report.approvalStatus}</span>
            </li>
          ))}
        </ul>
      </Panel>
      {message ? <p className="text-xs text-muted lg:col-span-2">{message}</p> : null}
    </div>
  );
}

export function ModelOpsSection() {
  const [data, setData] = useState<{
    tiers: string[];
    endpoints: Array<{ id: string; kind: string; tier: string; model: string; availability?: string }>;
    assignments: Array<{ agentOrTask: string; tier: string; primaryEndpointId: string }>;
    separatedReviewer?: { separated: boolean; forgeEndpointId: string; challengeEndpointId: string };
    liveCallsEnabled?: boolean;
    usage: Array<{
      agentOrTask: string;
      endpointId: string;
      ok: boolean;
      latencyMs: number;
      costUsdEst: string;
      provenance?: string;
      costKind?: string;
      createdAt: string;
    }>;
  } | null>(null);

  useEffect(() => {
    void api<NonNullable<typeof data>>("/evolution/models").then(setData).catch(() => setData(null));
  }, []);

  return (
    <div className="grid gap-3 lg:grid-cols-2 animate-odin-fade">
      <Panel title="AI Model Operations" extra={data?.liveCallsEnabled ? "Live endpoints configured" : "Live calls disabled"}>
        {!data ? (
          <EmptyState title="No model ops data" />
        ) : (
          <div className="space-y-3 p-3 text-sm">
            <div className="flex flex-wrap gap-2">
              {data.tiers.map((tier) => (
                <span key={tier} className="rounded border border-border px-2 py-1 text-[11px]">
                  {tier}
                </span>
              ))}
            </div>
            <ul className="space-y-1 text-xs">
              {data.endpoints.map((endpoint) => (
                <li key={endpoint.id} className="mono text-muted">
                  {endpoint.id} · {endpoint.kind} · {endpoint.tier} · model={endpoint.model} · {endpoint.availability ?? "UNAVAILABLE"}
                </li>
              ))}
              {data.separatedReviewer ? (
                <li className="text-muted">
                  Reviewer separation {String(data.separatedReviewer.separated)} · {data.separatedReviewer.forgeEndpointId} /{" "}
                  {data.separatedReviewer.challengeEndpointId}
                </li>
              ) : null}
            </ul>
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted">Assignments</div>
            <ul className="space-y-1 text-xs">
              {data.assignments.map((row) => (
                <li key={row.agentOrTask}>
                  {row.agentOrTask} → {row.primaryEndpointId} ({row.tier})
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>
      <Panel title="Usage / cost log">
        <ul className="divide-y divide-border text-xs">
          {(data?.usage ?? []).slice(0, 40).map((row, index) => (
            <li key={`${row.createdAt}-${index}`} className="flex justify-between gap-2 px-3 py-2">
              <span>
                {row.agentOrTask} · {row.endpointId} · {row.provenance ?? (row.ok ? "recorded" : "unavailable")} · {row.costKind ?? "ESTIMATED"}
              </span>
              <span className="mono text-muted">
                {row.latencyMs}ms · ${row.costUsdEst}
              </span>
            </li>
          ))}
          {(data?.usage.length ?? 0) === 0 ? (
            <li className="p-3 text-muted">No usage yet — run a research pipeline.</li>
          ) : null}
        </ul>
      </Panel>
    </div>
  );
}

export function GenomeSection() {
  const [data, setData] = useState<{
    strategies: Array<{ id: string; name: string; version: number; status: string; parentId: string | null }>;
    transitions: Array<{ strategyId: string; from: string; to: string; actor: string; evidenceHash: string; at: string }>;
  } | null>(null);

  useEffect(() => {
    void api<NonNullable<typeof data>>("/evolution/genome").then(setData).catch(() => setData(null));
  }, []);

  return (
    <div className="grid gap-3 lg:grid-cols-2 animate-odin-fade">
      <Panel title="Strategy Evolution">
        <ul className="divide-y divide-border text-sm">
          {(data?.strategies ?? []).map((row) => (
            <li key={row.id} className="flex justify-between gap-2 px-3 py-2">
              <span>
                {row.name} v{row.version}
                <span className="mt-0.5 block text-xs text-muted">
                  {row.parentId ? `child of ${row.parentId}` : "root strategy"}
                </span>
              </span>
              <span className="mono text-xs text-muted">{row.status}</span>
            </li>
          ))}
          {(data?.strategies.length ?? 0) === 0 ? (
            <li className="p-3 text-muted">No strategy versions yet.</li>
          ) : null}
        </ul>
      </Panel>
      <Panel title="Evolution Timeline">
        <ul className="divide-y divide-border text-xs">
          {(data?.transitions ?? []).map((row, index) => (
            <li key={`${row.evidenceHash}-${index}`} className="px-3 py-2">
              <div className="flex justify-between gap-2">
                <span className="mono">
                  {row.from} → {row.to}
                </span>
                <span className="text-muted">{row.actor}</span>
              </div>
              <div className="mt-0.5 text-muted">
                {row.strategyId} · {row.evidenceHash.slice(0, 12)}… · {row.at}
              </div>
            </li>
          ))}
          {(data?.transitions.length ?? 0) === 0 ? (
            <li className="p-3 text-muted">No audited transitions yet.</li>
          ) : null}
        </ul>
      </Panel>
    </div>
  );
}

export function ResearchMemorySection() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<
    Array<{ tradeId: string; pairAddress: string; phase: string; postExit: boolean; capturedAt: string }>
  >([]);

  async function search() {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    const data = await api<typeof rows>(`/evolution/memory?${params.toString()}`);
    setRows(data);
  }

  useEffect(() => {
    void search().catch(() => setRows([]));
  }, []);

  return (
    <div className="space-y-3 animate-odin-fade">
      <Panel
        title="Research Memory"
        extra={
          <div className="flex items-center gap-2">
            <input
              className="h-7 rounded border border-border bg-transparent px-2 text-xs"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="Search context"
            />
            <Button size="xs" variant="outline" onClick={() => void search()}>
              Search
            </Button>
          </div>
        }
      >
        <ul className="divide-y divide-border text-xs">
          {rows.map((row, index) => (
            <li key={`${row.tradeId}-${row.phase}-${index}`} className="flex justify-between gap-2 px-3 py-2">
              <span>
                {row.tradeId} · {row.phase}
                {row.postExit ? " · post-exit" : ""}
              </span>
              <span className="text-muted">{row.capturedAt}</span>
            </li>
          ))}
          {rows.length === 0 ? (
            <li className="p-3 text-muted">No memory rows. Post-exit context never feeds entry reconstruction.</li>
          ) : null}
        </ul>
      </Panel>
    </div>
  );
}

export function AutonomySection() {
  const [policy, setPolicy] = useState<{
    level: number;
    realMoneyExecutionEnabled: boolean;
    allowUnreviewedCodeDeploy: boolean;
    maxResearchIterations: number;
    maxResearchBudgetUsd: string;
    notes: string;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPolicy(await api("/evolution/autonomy"));
  }, []);

  useEffect(() => {
    void load().catch(() => setPolicy(null));
  }, [load]);

  async function setLevel(level: number) {
    setMessage(null);
    try {
      await api("/evolution/autonomy", { method: "POST", body: JSON.stringify({ level }) });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Update failed");
    }
  }

  return (
    <div className="space-y-3 animate-odin-fade">
      <Panel title="Autonomy Control" extra="Default ≤ 2 · Level 4 disabled">
        {!policy ? (
          <EmptyState title="Autonomy policy unavailable" />
        ) : (
          <div className="space-y-3 p-4 text-sm">
            <div className="flex flex-wrap gap-2">
              {[0, 1, 2, 3].map((level) => (
                <Button
                  key={level}
                  size="xs"
                  variant={policy.level === level ? "default" : "outline"}
                  onClick={() => void setLevel(level)}
                >
                  L{level}
                </Button>
              ))}
              <Button size="xs" variant="outline" disabled title="No real-money execution adapter">
                L4 disabled
              </Button>
            </div>
            <dl className="grid gap-2 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Real money</dt>
                <dd className="mono">{String(policy.realMoneyExecutionEnabled)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Unreviewed deploy</dt>
                <dd className="mono">{String(policy.allowUnreviewedCodeDeploy)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Research budget</dt>
                <dd className="mono">
                  ${policy.maxResearchBudgetUsd} / {policy.maxResearchIterations} iters
                </dd>
              </div>
            </dl>
            <p className="text-xs text-muted">{policy.notes}</p>
            {message ? <p className="text-xs text-loss">{message}</p> : null}
          </div>
        )}
      </Panel>
    </div>
  );
}
