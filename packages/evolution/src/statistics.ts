import { d, usd, Decimal } from "@odin/shared";

export type StatReading = {
  status: "MEASURED" | "UNAVAILABLE";
  value: string | null;
  reason: string | null;
};

export type StatisticsReport = {
  totalReturnPct: StatReading;
  netProfitUsd: StatReading;
  winRate: StatReading;
  averageWinUsd: StatReading;
  averageLossUsd: StatReading;
  expectancyUsd: StatReading;
  profitFactor: StatReading;
  maxDrawdownPct: StatReading;
  averageExposureUsd: StatReading;
  sharpe: StatReading;
  sortino: StatReading;
  returnVolatility: StatReading;
  confidenceInterval95: StatReading;
  sampleSize: number;
  observationSpanMs: number | null;
  costSensitivity: StatReading;
  parameterStability: StatReading;
};

const MIN_STAT_SAMPLE = 30;

function measured(value: string): StatReading {
  return { status: "MEASURED", value, reason: null };
}

function unavailable(reason: string): StatReading {
  return { status: "UNAVAILABLE", value: null, reason };
}

export function summariseStatistics(input: {
  startingEquityUsd: string;
  endingEquityUsd: string | null;
  netProfitUsd: string | null;
  closedPnls: string[];
  equitySeries: Array<string | null>;
  exposureSeries: Array<string | null>;
  observationSpanMs: number | null;
  feeBps: string | null;
  alternativeFeeReturns: string[] | null;
  parameterReturns: string[] | null;
}): StatisticsReport {
  const sampleSize = input.closedPnls.length;
  const pnls = input.closedPnls.map((value) => d(value));
  const wins = pnls.filter((value) => value.gt(0));
  const losses = pnls.filter((value) => value.lt(0));
  const enough = sampleSize >= MIN_STAT_SAMPLE;

  const totalReturnPct =
    input.endingEquityUsd === null
      ? unavailable("Ending equity is null")
      : measured(d(input.endingEquityUsd).minus(d(input.startingEquityUsd)).div(d(input.startingEquityUsd)).mul(100).toFixed(6));

  const netProfitUsd = input.netProfitUsd === null ? unavailable("Net profit is null") : measured(input.netProfitUsd);
  const winRate = sampleSize === 0 ? unavailable("No closed trades") : measured(new Decimal(wins.length).div(sampleSize).toFixed(6));
  const averageWinUsd = wins.length === 0 ? unavailable("No winning trades") : measured(usd(sum(wins).div(wins.length)));
  const averageLossUsd =
    losses.length === 0 ? unavailable("No losing trades") : measured(usd(sum(losses.map((value) => value.abs())).div(losses.length)));
  const expectancyUsd = sampleSize === 0 ? unavailable("No closed trades") : measured(usd(sum(pnls).div(sampleSize)));
  const grossLoss = sum(losses.map((value) => value.abs()));
  const profitFactor =
    wins.length === 0 || grossLoss.lte(0) ? unavailable("Profit factor needs wins and losses") : measured(sum(wins).div(grossLoss).toFixed(6));

  const equity = input.equitySeries.filter((value): value is string => value !== null);
  const maxDrawdownPct = equity.length < 2 ? unavailable("Equity series is too short") : measured(maxDrawdown(equity));
  const exposures = input.exposureSeries.filter((value): value is string => value !== null);
  const averageExposureUsd =
    exposures.length === 0 ? unavailable("Exposure series is empty") : measured(usd(sum(exposures.map((value) => d(value))).div(exposures.length)));

  const returns = simpleReturns(equity);
  const volatility = returns.length < MIN_STAT_SAMPLE ? unavailable(`Need ${MIN_STAT_SAMPLE} returns for volatility`) : measured(stdev(returns).toFixed(6));
  const sharpe =
    !enough || returns.length < MIN_STAT_SAMPLE || stdev(returns).lte(0)
      ? unavailable("Sharpe needs 30 non-zero-variance returns")
      : measured(mean(returns).div(stdev(returns)).toFixed(6));
  const downside = returns.filter((value) => value.lt(0));
  const sortino =
    !enough || downside.length < 5
      ? unavailable("Sortino needs a larger downside sample")
      : measured(mean(returns).div(stdev(downside)).toFixed(6));
  const confidenceInterval95 =
    !enough
      ? unavailable(`Confidence interval needs ${MIN_STAT_SAMPLE} closed trades`)
      : measured(confidenceInterval(pnls));

  const costSensitivity =
    !input.alternativeFeeReturns || input.alternativeFeeReturns.length < 2
      ? unavailable("Cost sensitivity needs at least two fee scenarios")
      : measured(input.alternativeFeeReturns.join(","));
  const parameterStability =
    !input.parameterReturns || input.parameterReturns.length < 2
      ? unavailable("Parameter stability needs more than one untouched parameterisation")
      : measured(spread(input.parameterReturns.map((value) => d(value))).toFixed(6));

  return {
    totalReturnPct,
    netProfitUsd,
    winRate,
    averageWinUsd,
    averageLossUsd,
    expectancyUsd,
    profitFactor,
    maxDrawdownPct,
    averageExposureUsd,
    sharpe,
    sortino,
    returnVolatility: volatility,
    confidenceInterval95,
    sampleSize,
    observationSpanMs: input.observationSpanMs,
    costSensitivity,
    parameterStability,
  };
}

function sum(values: Decimal[]): Decimal {
  return values.reduce((total, value) => total.plus(value), d("0"));
}

function mean(values: Decimal[]): Decimal {
  if (values.length === 0) return d("0");
  return sum(values).div(values.length);
}

function stdev(values: Decimal[]): Decimal {
  if (values.length < 2) return d("0");
  const avg = mean(values);
  const variance = sum(values.map((value) => value.minus(avg).pow(2))).div(values.length - 1);
  return variance.sqrt();
}

function simpleReturns(equity: string[]): Decimal[] {
  const out: Decimal[] = [];
  for (let i = 1; i < equity.length; i += 1) {
    const prev = d(equity[i - 1]!);
    if (prev.lte(0)) continue;
    out.push(d(equity[i]!).minus(prev).div(prev));
  }
  return out;
}

function maxDrawdown(equity: string[]): string {
  let peak = d(equity[0]!);
  let max = d("0");
  for (const point of equity) {
    const value = d(point);
    if (value.gt(peak)) peak = value;
    if (peak.gt(0)) {
      const dd = peak.minus(value).div(peak).mul(100);
      if (dd.gt(max)) max = dd;
    }
  }
  return max.toFixed(6);
}

function confidenceInterval(pnls: Decimal[]): string {
  const avg = mean(pnls);
  const se = stdev(pnls).div(Decimal.sqrt(pnls.length));
  const low = avg.minus(se.mul("1.96"));
  const high = avg.plus(se.mul("1.96"));
  return `${usd(low)}..${usd(high)}`;
}

function spread(values: Decimal[]): Decimal {
  return Decimal.max(...values).minus(Decimal.min(...values));
}
