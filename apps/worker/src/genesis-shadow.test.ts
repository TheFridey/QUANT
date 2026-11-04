import type { PrismaClient } from "@odin/shared/db";
import type { Queue } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";
import { GENESIS_SHADOW_QUEUE, GenesisShadowProcessor, GenesisShadowScheduler } from "./genesis-shadow.js";

function fakeQueue() {
  const added: unknown[] = [];
  const removed: string[] = [];
  const queue = {
    getRepeatableJobs: async () => [{ key: "old" }],
    removeRepeatableByKey: async (key: string) => void removed.push(key),
    add: async (...args: unknown[]) => void added.push(args),
  } as unknown as Queue;
  return { queue, added, removed };
}

describe("GENESIS shadow worker job", () => {
  const saved = process.env.GENESIS_SHADOW_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.GENESIS_SHADOW_ENABLED;
    else process.env.GENESIS_SHADOW_ENABLED = saved;
  });

  it("uses its own queue, separate from trading stage queues", () => {
    expect(GENESIS_SHADOW_QUEUE).toBe("odin.genesis-shadow");
  });

  it("schedules nothing by default and clears stale repeatables", async () => {
    delete process.env.GENESIS_SHADOW_ENABLED;
    const q = fakeQueue();
    await new GenesisShadowScheduler(q.queue).onModuleInit();
    expect(q.removed).toEqual(["old"]);
    expect(q.added).toEqual([]);
  });

  it("schedules one bounded repeat job only when the flag is exactly true", async () => {
    process.env.GENESIS_SHADOW_ENABLED = "true";
    const q = fakeQueue();
    await new GenesisShadowScheduler(q.queue).onModuleInit();
    expect(q.added).toHaveLength(1);
    expect(q.added[0]).toEqual(["genesis-shadow-cycle", {}, expect.objectContaining({ attempts: 1, repeat: { every: 300_000 } })]);
  });

  it("the processor touches no table while disabled", async () => {
    delete process.env.GENESIS_SHADOW_ENABLED;
    const prisma = new Proxy({}, { get: () => { throw new Error("database touched while disabled"); } }) as unknown as PrismaClient;
    await expect(new GenesisShadowProcessor(prisma).process()).resolves.toBeUndefined();
  });
});
