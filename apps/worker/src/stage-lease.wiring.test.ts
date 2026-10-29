import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Call-site evidence for D51: processors + module wire Redis stage leases.
 * Algorithm coverage lives in packages/risk-engine redis-worker-lease.test.
 */
describe("stage lease BullMQ wiring (D51)", () => {
  it("processors acquire/release ingest and stage leases before stage work", () => {
    const processors = readFileSync(new URL("./processors.ts", import.meta.url), "utf8");
    expect(processors).toContain("StageLeaseService");
    expect(processors).toContain("tryAcquireIngest");
    expect(processors).toContain("tryAcquireStage");
    expect(processors).toContain("withStageLease");
    expect(processors).toContain("leases.release");
  });

  it("worker module provides StageLeaseService to processors", () => {
    const mod = readFileSync(new URL("./worker.module.ts", import.meta.url), "utf8");
    expect(mod).toContain("StageLeaseService");
  });

  it("stage-lease uses Redis SET NX PX fencing tokens", () => {
    const lease = readFileSync(new URL("./stage-lease.ts", import.meta.url), "utf8");
    expect(lease).toContain('set(key, value, "PX"');
    expect(lease).toContain('"NX"');
    expect(lease).toContain("DistributedWorkerLeaseManager");
    expect(lease).toContain("cycleStageLeaseKey");
  });
});
