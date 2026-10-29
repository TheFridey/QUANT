"use client";

import { Panel } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { Label } from "@/components/ui/label";

const INTERVALS = [
  { label: "2s", ms: 2000 },
  { label: "5s", ms: 5000 },
  { label: "10s", ms: 10000 },
  { label: "30s", ms: 30000 },
];

export function SettingsSection() {
  const { refreshMs, setRefreshMs, socketState, snapshot } = useSnapshot();

  return (
    <div className="grid gap-3 lg:grid-cols-2 animate-odin-fade">
      <Panel title="Refresh interval">
        <div className="space-y-3 p-4">
          <Label>Snapshot polling</Label>
          <div className="flex flex-wrap gap-2">
            {INTERVALS.map((item) => (
              <button
                key={item.ms}
                type="button"
                onClick={() => setRefreshMs(item.ms)}
                className={`rounded border px-3 py-1.5 text-xs ${refreshMs === item.ms ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted"}`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted">Socket.IO terminal nudges still trigger incremental refreshes independently.</p>
        </div>
      </Panel>
      <Panel title="Session">
        <dl className="space-y-2 p-4 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted">API socket</dt>
            <dd className="mono">{socketState}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Venue</dt>
            <dd className="mono">{snapshot?.venue ?? "PAPER"}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Market mode</dt>
            <dd className="mono uppercase">{snapshot?.market.mode ?? "—"}</dd>
          </div>
          <p className="pt-2 text-xs text-muted">Paper trading only. No wallet, no private keys, no live order routing.</p>
        </dl>
      </Panel>
      <Panel title="Multi-market controls" className="lg:col-span-2">
        <dl className="grid grid-cols-2 gap-3 p-4 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Environment</dt>
            <dd className="mono">{snapshot?.execution?.tradingEnvironment ?? "MARKET_DATA_PAPER"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Multi-market ingest</dt>
            <dd className="mono">{snapshot?.execution?.multiMarketPaperIngest ? "on" : "off"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">DEMO entries</dt>
            <dd className="mono">{snapshot?.execution?.allowDemoPaperEntries ? "allowed" : "blocked"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Pause new entries</dt>
            <dd className="mono">{snapshot?.execution?.pauseNewEntries ? "yes" : "no"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Alpaca</dt>
            <dd className="mono">{snapshot?.execution?.providerReadiness?.alpaca_paper ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">OANDA</dt>
            <dd className="mono">{snapshot?.execution?.providerReadiness?.oanda_practice ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Metrics account</dt>
            <dd className="mono">{snapshot?.execution?.metricsAccountId ?? "primary"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Flatten requested</dt>
            <dd className="mono">{snapshot?.engine.flattenRequested ? "yes" : "no"}</dd>
          </div>
        </dl>
        <p className="border-t border-border px-4 py-3 text-[11px] text-muted">
          FIXTURE ingest never feeds MARKET_DATA_PAPER. Named providers stay MISSING_CREDENTIALS until practice keys are set — never fake LIVE.
        </p>
      </Panel>
    </div>
  );
}
