import { UnrecoverableError, type Job } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failIfExhausted, STAGE_TIMEOUT_MS, StageTimeoutError, withStageLease, withStageOverrunAlert, withStageTimeout } from "./processors.js";

const never = () => new Promise<void>(() => undefined);
const leases = () => ({ tryAcquireStage: vi.fn(async () => ({}) as never), release: vi.fn(async () => undefined) });

describe("stage timeouts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("abandons a hung stage with a non-retryable error and releases its lease", async () => {
    const lease = leases();
    const pending = withStageLease(lease, "sentinel", "cyc_1", never);
    const result = expect(pending).rejects.toBeInstanceOf(StageTimeoutError);
    await vi.advanceTimersByTimeAsync(STAGE_TIMEOUT_MS);
    await result;
    await expect(pending).rejects.toBeInstanceOf(UnrecoverableError);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it("returns a result that arrives in time and leaves no timer behind", async () => {
    await expect(withStageTimeout("pulse", 1_000, async () => "done")).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes through a stage's own error unchanged, so normal retries still apply", async () => {
    const boom = new Error("db down");
    await expect(withStageTimeout("pulse", 1_000, async () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it("does not raise an unhandled rejection when abandoned work fails later", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    let failLate: (e: Error) => void = () => undefined;
    const pending = withStageTimeout("pulse", 1_000, () => new Promise<void>((_r, reject) => (failLate = reject)));
    const result = expect(pending).rejects.toBeInstanceOf(StageTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
    failLate(new Error("late"));
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 5));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("never abandons the executor: an overrun alerts and the stage keeps its lease until it finishes", async () => {
    const lease = leases();
    let finish: () => void = () => undefined;
    const run = () => new Promise<void>((resolve) => (finish = resolve));
    let settled = false;
    const pending = withStageLease(lease, "executor", "cyc_1", run, undefined, withStageOverrunAlert).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(STAGE_TIMEOUT_MS * 5);
    expect(settled).toBe(false);
    expect(lease.release).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it("fails the cycle at once on a timeout, but still waits out retries for other errors", async () => {
    const stages = { fail: vi.fn(async () => undefined) };
    const job = { data: { cycleId: "cyc_1" }, opts: { attempts: 3 }, attemptsMade: 1 } as unknown as Job<{ cycleId?: string }>;
    await failIfExhausted(stages, job, new Error("transient"));
    expect(stages.fail).not.toHaveBeenCalled();
    await failIfExhausted(stages, job, new StageTimeoutError("sentinel", STAGE_TIMEOUT_MS));
    expect(stages.fail).toHaveBeenCalledWith("cyc_1", expect.stringContaining("STAGE_TIMEOUT"));
  });
});
