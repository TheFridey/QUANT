import { afterEach, describe, expect, it } from "vitest";
import { type MetricLine, recordMetric, setMetricSink, timed } from "./metrics.js";

describe("structured metrics (audit F5)", () => {
  const lines: MetricLine[] = [];
  setMetricSink((line) => lines.push(line));
  afterEach(() => {
    lines.length = 0;
  });

  it("records a metric line with labels and unit", () => {
    recordMetric("odin_queue_lag_ms", 42, { stage: "pulse" });
    expect(lines).toEqual([expect.objectContaining({ metric: "odin_queue_lag_ms", value: 42, unit: "ms", labels: { stage: "pulse" } })]);
  });

  it("drops non-finite values and never throws from a broken sink", () => {
    recordMetric("x", Number.NaN);
    expect(lines).toHaveLength(0);
    setMetricSink(() => {
      throw new Error("sink down");
    });
    expect(() => recordMetric("x", 1)).not.toThrow();
    setMetricSink((line) => lines.push(line));
  });

  it("timed labels the outcome and rethrows errors", async () => {
    await expect(timed("odin_stage_duration_ms", { stage: "aegis" }, async () => 7)).resolves.toBe(7);
    await expect(
      timed("odin_stage_duration_ms", { stage: "aegis" }, async () => {
        throw new TypeError("boom");
      }),
    ).rejects.toThrow("boom");
    expect(lines.map((line) => line.labels.outcome)).toEqual(["ok", "TypeError"]);
  });
});
