/**
 * Audit F5: structured log metrics. Each measurement is one JSON line with a metric name, value and
 * labels, so any log pipeline can aggregate it (or scrape it into Prometheus) without a new
 * dependency. Processes may route lines through their own logger with setMetricSink.
 */
export type MetricLine = {
  metric: string;
  value: number;
  unit: "ms" | "count";
  labels: Record<string, string>;
  at: string;
};

export type MetricSink = (line: MetricLine) => void;

const stdoutSink: MetricSink = (line) => {
  process.stdout.write(`${JSON.stringify({ type: "metric", ...line })}\n`);
};

let sink: MetricSink = stdoutSink;

export function setMetricSink(next: MetricSink | null): void {
  sink = next ?? stdoutSink;
}

export function recordMetric(
  metric: string,
  value: number,
  labels: Record<string, string> = {},
  unit: MetricLine["unit"] = "ms",
): void {
  if (!Number.isFinite(value)) return;
  try {
    sink({ metric, value, unit, labels, at: new Date().toISOString() });
  } catch {
    // Metrics must never break the caller.
  }
}

/** Time an async operation and record its duration with an `outcome` label (ok / error). */
export async function timed<T>(metric: string, labels: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const value = await run();
    recordMetric(metric, Date.now() - started, { ...labels, outcome: "ok" });
    return value;
  } catch (error) {
    recordMetric(metric, Date.now() - started, {
      ...labels,
      outcome: error instanceof Error && error.name ? error.name : "error",
    });
    throw error;
  }
}
