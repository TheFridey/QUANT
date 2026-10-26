import type { BaselineResult } from "./baselines.js";
import type { BacktestResult } from "./types.js";
import type { MonteCarloResult, ReleaseGateResult, SampleGateResult } from "./validation.js";

export type ResearchReportInput = {
  runId: string;
  generatedAt: string;
  strategyName: string;
  strategyVersion: number | null;
  result: BacktestResult;
  metrics: Record<string, unknown>;
  baselines: BaselineResult[];
  sampleGate: SampleGateResult;
  releaseGate: ReleaseGateResult;
  monteCarlo: MonteCarloResult;
  oracleSummary?: string | null;
};

/** HTML research report — simulation results clearly labelled; reproducible metrics. */
export function renderResearchReportHtml(input: ResearchReportInput): string {
  const { result, metrics, baselines, sampleGate, releaseGate, monteCarlo } = input;
  const insufficient = sampleGate.label === "INSUFFICIENT_EVIDENCE";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>ODIN // QUANT Research Report — ${escapeHtml(input.runId)}</title>
<style>
  :root { color-scheme: light; --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --warn:#b45309; --bad:#b91c1c; --ok:#047857; --sim:#1d4ed8; }
  body { font-family: "IBM Plex Sans", "Segoe UI", sans-serif; margin: 0; background: linear-gradient(180deg,#f8fafc,#eef2ff); color: var(--ink); }
  main { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 1.6rem; margin: 0 0 0.25rem; letter-spacing: -0.02em; }
  h2 { font-size: 1.1rem; margin: 1.75rem 0 0.5rem; border-bottom: 1px solid var(--line); padding-bottom: 0.35rem; }
  .banner { background: #dbeafe; color: #1e3a8a; border: 1px solid #93c5fd; padding: 12px 14px; border-radius: 8px; margin: 16px 0; font-weight: 600; }
  .warn { background: #fff7ed; color: var(--warn); border-color: #fdba74; }
  .bad { background: #fef2f2; color: var(--bad); border-color: #fecaca; }
  table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  .mono { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 0.85rem; }
  .null { color: var(--muted); font-style: italic; }
  ul { margin: 0.4rem 0 0; padding-left: 1.2rem; }
  footer { margin-top: 2rem; color: var(--muted); font-size: 0.8rem; }
</style>
</head>
<body>
<main>
  <p class="mono" style="color:var(--muted);margin:0">ODIN // QUANT · paper research laboratory</p>
  <h1>Research report</h1>
  <p>Run <span class="mono">${escapeHtml(input.runId)}</span> · ${escapeHtml(input.generatedAt)} · strategy ${escapeHtml(input.strategyName)}${input.strategyVersion !== null ? ` v${input.strategyVersion}` : ""}</p>
  <div class="banner">SIMULATION RESULTS — paper venue only. Not live trading. Not real-money validated. There is no real-money graduation path in this system.</div>
  ${insufficient ? `<div class="banner warn">INSUFFICIENT EVIDENCE — sample gates failed. Do not treat metrics as validated.</div>` : ""}
  <div class="banner bad">Release gate: ${escapeHtml(releaseGate.label)}. Real-money graduation: false. Forward paper evaluation required.</div>

  <h2>Assumptions</h2>
  <ul>${result.assumptions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>

  <h2>Data quality</h2>
  <table>
    <tr><th>Observations</th><td class="mono">${result.dataQuality.observationCount}</td></tr>
    <tr><th>Pairs</th><td class="mono">${result.dataQuality.pairCount}</td></tr>
    <tr><th>Span</th><td class="mono">${result.dataQuality.spanMs ?? "null"} ms</td></tr>
    <tr><th>Missing prices</th><td class="mono">${result.dataQuality.missingPriceCount}</td></tr>
    <tr><th>Missing liquidity</th><td class="mono">${result.dataQuality.missingLiquidityCount}</td></tr>
    <tr><th>Disappeared pairs</th><td class="mono">${result.dataQuality.disappearedPairs.length}</td></tr>
    <tr><th>Inactive pairs</th><td class="mono">${result.dataQuality.inactivePairs.length}</td></tr>
    <tr><th>Gaps reported</th><td class="mono">${result.dataQuality.gaps.length}</td></tr>
  </table>
  ${renderPairList("Disappeared / delisted (reported, not dropped)", result.dataQuality.disappearedPairs.map((p) => `${p.baseSymbol} ${p.pairAddress} last=${p.lastSeenAt}`))}
  ${renderPairList("Inactive (no positive price)", result.dataQuality.inactivePairs.map((p) => `${p.baseSymbol} ${p.pairAddress} (${p.reason})`))}

  <h2>Performance (strategy)</h2>
  <table>
    ${metricRow("Sample size (closed trades)", metrics.sampleSize)}
    ${metricRow("Return %", metrics.returnPct)}
    ${metricRow("Win rate", metrics.winRate)}
    ${metricRow("Profit factor", metrics.profitFactor)}
    ${metricRow("Expectancy USD", metrics.expectancyUsd)}
    ${metricRow("Max drawdown %", metrics.maxDrawdownPct)}
    ${metricRow("Fees USD", metrics.feesUsd)}
    ${metricRow("Final equity USD", result.finalEquityUsd)}
    ${metricRow("Rejected orders", metrics.rejectedOrderCount)}
    ${metricRow("Observed", metrics.observed)}
  </table>

  <h2>Sample / release gates</h2>
  <table>
    <tr><th>Sample gate</th><td>${escapeHtml(sampleGate.label)} · passed=${sampleGate.passed}</td></tr>
    <tr><th>Sample reasons</th><td>${sampleGate.reasons.map(escapeHtml).join("; ") || "—"}</td></tr>
    <tr><th>Release gate</th><td>${escapeHtml(releaseGate.label)} · passed=${releaseGate.passed}</td></tr>
    <tr><th>Release reasons</th><td>${releaseGate.reasons.map(escapeHtml).join("; ")}</td></tr>
  </table>

  <h2>Baselines</h2>
  <table>
    <tr><th>Name</th><th>Return %</th><th>Final equity</th><th>Label</th></tr>
    ${baselines
      .map(
        (b) =>
          `<tr><td>${escapeHtml(b.name)}</td><td class="mono">${fmt(b.returnPct)}</td><td class="mono">${fmt(b.finalEquityUsd)}</td><td>${escapeHtml(b.label)}</td></tr>`,
      )
      .join("")}
  </table>

  <h2>Monte Carlo (trade-sequence resample)</h2>
  <table>
    <tr><th>Seed</th><td class="mono">${monteCarlo.seed}</td></tr>
    <tr><th>Iterations</th><td class="mono">${monteCarlo.iterations}</td></tr>
    <tr><th>Label</th><td>${escapeHtml(monteCarlo.label)}</td></tr>
    <tr><th>Mean final equity</th><td class="mono">${fmt(monteCarlo.meanFinalEquity)}</td></tr>
    <tr><th>p05 / p50 / p95</th><td class="mono">${fmt(monteCarlo.p05)} / ${fmt(monteCarlo.p50)} / ${fmt(monteCarlo.p95)}</td></tr>
  </table>

  ${input.oracleSummary ? `<h2>ORACLE advisory (non-binding)</h2><p>${escapeHtml(input.oracleSummary)}</p>` : ""}

  <h2>Trades (${result.trades.length})</h2>
  <table>
    <tr><th>Time</th><th>Side</th><th>Symbol</th><th>Price</th><th>Qty</th><th>Fee</th><th>PnL</th><th>Reasons</th></tr>
    ${result.trades
      .slice(0, 200)
      .map(
        (t) =>
          `<tr><td class="mono">${escapeHtml(t.eventAt)}</td><td>${t.side}</td><td>${escapeHtml(t.baseSymbol)}</td><td class="mono">${t.priceUsd}</td><td class="mono">${t.qty}</td><td class="mono">${t.feeUsd}</td><td class="mono">${fmt(t.pnlUsd)}</td><td class="mono">${t.reasonCodes.join(",")}</td></tr>`,
      )
      .join("")}
  </table>
  ${result.trades.length > 200 ? `<p class="null">Showing first 200 of ${result.trades.length} trades.</p>` : ""}

  <footer>
    Reproducible from persisted MarketObservation / fixture provenance. Costs, latency, and liquidity constraints are applied in-engine.
    Optimisation that merely maximises in-sample returns is rejected when sample gates fail.
    Generated ${escapeHtml(input.generatedAt)}.
  </footer>
</main>
</body>
</html>`;
}

function metricRow(label: string, value: unknown): string {
  return `<tr><th>${escapeHtml(label)}</th><td class="mono">${fmt(value)}</td></tr>`;
}

function renderPairList(title: string, items: string[]): string {
  if (items.length === 0) return "";
  return `<p><strong>${escapeHtml(title)}</strong></p><ul>${items
    .slice(0, 50)
    .map((item) => `<li class="mono">${escapeHtml(item)}</li>`)
    .join("")}</ul>`;
}

function fmt(value: unknown): string {
  if (value === null || value === undefined) return `<span class="null">null — insufficient evidence</span>`;
  return escapeHtml(String(value));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
