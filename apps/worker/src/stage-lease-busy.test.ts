import { describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { failIfExhausted, StageLeaseBusyError, withStageLease } from "./processors.js";

/** Audit M8: a held stage lease must retry the job, never report success and drop the next stage. */

function leases(held: boolean[]) {
  const attempts = [...held];
  return {
    tryAcquireStage: vi.fn(async () => (attempts.shift() ? null : { key: "k", token: "t" })),
    release: vi.fn(async () => undefined),
  };
}

describe("stage lease busy", () => {
  it("throws a retryable error instead of completing when the lease is held", async () => {
    const run = vi.fn(async () => undefined);
    await expect(withStageLease(leases([true]) as never, "pulse", "cyc_1", run)).rejects.toBeInstanceOf(StageLeaseBusyError);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the stage and enqueues the next one on the retry that gets the lease", async () => {
    const lease = leases([true, false]);
    const enqueued: string[] = [];
    const attempt = () =>
      withStageLease(lease as never, "pulse", "cyc_1", async () => {
        enqueued.push("aegis");
      });
    // BullMQ retries a thrown job; simulate the first failed attempt and the retry.
    await expect(attempt()).rejects.toBeInstanceOf(StageLeaseBusyError);
    await attempt();
    expect(enqueued).toEqual(["aegis"]);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it("does not fail the cycle when a busy lease exhausts its retries", async () => {
    const stages = { fail: vi.fn(async () => undefined) };
    const job = { data: { cycleId: "cyc_1" }, opts: { attempts: 3 }, attemptsMade: 3 } as unknown as Job<{ cycleId?: string }>;
    await failIfExhausted(stages as never, job, new StageLeaseBusyError("pulse", "cyc_1"));
    expect(stages.fail).not.toHaveBeenCalled();
    await failIfExhausted(stages as never, job, new Error("real failure"));
    expect(stages.fail).toHaveBeenCalledWith("cyc_1", "real failure");
  });
});
