"use client";

import { EmptyState, Panel } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";

export function BacktestingSection() {
  const { snapshot } = useSnapshot();
  const mode = snapshot?.market.mode;

  return (
    <Panel title="Backtesting" extra={mode === "replay" ? "REPLAY mode active" : "Paper live"} className="animate-odin-fade">
      {mode === "replay" || mode === "demo" ? (
        <div className="p-4 text-sm">
          <p>
            Data mode is <span className="mono uppercase text-warning">{mode}</span>. Fixture-backed replay is labelled in the command bar. Equity and fills remain ledger-sourced.
          </p>
        </div>
      ) : (
        <EmptyState
          title="No backtest session attached"
          detail="Replay/demo only appears when DATA_MODE is replay or demo with fixture-backed market data. Live paper mode does not invent historical fills."
        />
      )}
    </Panel>
  );
}
