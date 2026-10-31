import { DEFAULT_STRATEGY, type StrategyConfig } from "./strategy.js";

/**
 * Audit F4: the risk-limits tables in README.md and docs/ARCHITECTURE.md are generated from
 * DEFAULT_STRATEGY, so the docs cannot drift from the code. `node scripts/render-limits.mjs`
 * rewrites them; `limits-table.test.ts` fails CI when they are out of date.
 */
export const LIMITS_START = "<!-- limits:start (generated from DEFAULT_STRATEGY by scripts/render-limits.mjs; do not edit) -->";
export const LIMITS_END = "<!-- limits:end -->";

const ROWS: ReadonlyArray<readonly [keyof StrategyConfig, string]> = [
  ["startingBalanceUsd", "Paper account starting balance (USD)"],
  ["maxPositions", "Open positions at once"],
  ["maxRiskPerTradePct", "Stop-distance risk per trade, % of equity"],
  ["maxPositionPctEquity", "Single position size, % of equity"],
  ["maxAggregateExposurePct", "All open positions, % of equity"],
  ["maxDailyLossPct", "Daily loss, % of start-of-day equity (Europe/London day)"],
  ["maxTotalDrawdownPct", "Drawdown from high-water mark, %"],
  ["maxParticipationPctLiquidity", "Entry notional, % of pool liquidity"],
  ["maxSlippageBps", "Entry slippage cap (bps)"],
  ["maxPriceImpactBps", "Entry price-impact cap (bps)"],
  ["maxExitImpactBps", "Exit impact per fill (bps); must be ≥ both entry caps; the rest becomes a pending reduce order"],
  ["minOrderNotionalUsd", "Smallest order (USD)"],
  ["minLiquidityUsd", "Minimum pool liquidity for entry (USD)"],
  ["minVolume24hUsd", "Minimum 24h volume for entry (USD)"],
  ["stopLossPct", "Stop loss, %"],
  ["takeProfitPct", "Take profit, %"],
  ["liveMaxAgeMs", "Quote age still LIVE (ms)"],
  ["delayedMaxAgeMs", "Quote age still DELAYED (ms); older is STALE"],
  ["allowDelayedExits", "Exits may use DELAYED quotes"],
  ["allowDemoPaperEntries", "DEMO entries (only ever with DATA_MODE=demo); DELAYED never opens risk"],
  ["paperLatencyMs", "Earliest paper fill after the decision (ms); measured CI soak median 706 ms, rounded up"],
  ["orderExpiryMs", "Pending order expiry (ms)"],
];

function cell(value: unknown): string {
  if (value === null || value === undefined) return "off";
  return `\`${String(value)}\``;
}

export function renderLimitsTable(config: StrategyConfig = DEFAULT_STRATEGY): string {
  const lines = ["| Limit | Default | Meaning |", "| --- | --- | --- |"];
  for (const [key, meaning] of ROWS) lines.push(`| \`${key}\` | ${cell(config[key])} | ${meaning} |`);
  return [LIMITS_START, "", ...lines, "", LIMITS_END].join("\n");
}

/** Replace the generated block in a markdown document. Throws if the markers are missing. */
export function replaceLimitsBlock(markdown: string, table: string = renderLimitsTable()): string {
  const start = markdown.indexOf(LIMITS_START);
  const end = markdown.indexOf(LIMITS_END);
  if (start === -1 || end === -1 || end < start) throw new Error("limits markers not found");
  return markdown.slice(0, start) + table + markdown.slice(end + LIMITS_END.length);
}
