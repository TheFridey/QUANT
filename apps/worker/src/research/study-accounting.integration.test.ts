import { createHash } from "node:crypto";
import { closeStudy, openStudies, openStudy, programmeTrials } from "@odin/evolution/campaign";
import { PrismaClient } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePriorTrials } from "./holdout-policy.js";

/**
 * OPERATION INTEGRITY F03/F06: exploratory-CLI trial accounting on real Postgres. Open before computing, close before
 * disclosing; idempotent per study key; crash- and outage-visible; concurrency reported. Separate PrismaClients stand
 * in for separate processes. No bars are evaluated; trial counts are synthetic.
 */
const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));
const salt = `${Date.now()}-${Math.random()}`;
const key = (name: string) => createHash("sha256").update(`${salt}:${name}`).digest("hex");

function barrier(n: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return async () => {
    arrived += 1;
    if (arrived === n) release();
    await gate;
  };
}

describe.skipIf(!enabled)("exploratory study trial accounting (F03, Postgres)", () => {
  let a: PrismaClient;
  let b: PrismaClient;
  beforeAll(async () => {
    a = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    b = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await Promise.all([a.$queryRaw`SELECT 1`, b.$queryRaw`SELECT 1`]);
  }, 60_000);
  afterAll(async () => {
    await a.$disconnect();
    await b.$disconnect();
  });

  const total = async () => (await programmeTrials(a)).total;
  const rowsFor = (k: string) => a.researchTrialLedger.findMany({ where: { note: { contains: k } }, orderBy: { createdAt: "asc" } });

  it("opening counts nothing but freezes the prior; closing counts the trials once, before disclosure", async () => {
    const k = key("happy");
    const before = await total();
    const opened = await openStudy(a, { studyKey: k, actor: "test", note: "happy path" });
    expect(opened.status).toBe("OPENED");
    expect(opened.priorTrials).toBe(before);
    expect(await total()).toBe(before);
    const closed = await closeStudy(a, { studyKey: k, trials: 37, actor: "test", note: "done" });
    expect(closed).toMatchObject({ status: "CLOSED", trials: 37 });
    expect(await total()).toBe(before + 37);
    expect((await openStudies(a)).map((s) => s.studyKey)).not.toContain(k);
  });

  it("a crash after opening (during or after evaluation) leaves a visible unclosed study, never a silent loss", async () => {
    const k = key("crash");
    await openStudy(a, { studyKey: k, actor: "test", note: "crashes before close" });
    // ...process dies here: nothing printed, so nothing was selected on...
    const open = await openStudies(a);
    expect(open.map((s) => s.studyKey)).toContain(k);
    expect(open.find((s) => s.studyKey === k)!.note).toContain("crashes before close");
  });

  it("retry after a crash reuses the frozen prior and counts the trials exactly once", async () => {
    const k = key("retry");
    const first = await openStudy(a, { studyKey: k, actor: "test", note: "first attempt" });
    await closeStudy(b, { studyKey: key("noise"), trials: 0, actor: "test", note: "x" }).catch(() => undefined);
    await openStudy(b, { studyKey: key("other-in-between"), actor: "test", note: "other" });
    await closeStudy(b, { studyKey: key("other-in-between"), trials: 11, actor: "test", note: "other" });
    const second = await openStudy(b, { studyKey: k, actor: "test", note: "retry" });
    expect(second.status).toBe("ALREADY_OPEN");
    expect(second.priorTrials).toBe(first.priorTrials);
    const before = await total();
    const c1 = await closeStudy(b, { studyKey: k, trials: 20, actor: "test", note: "retry closed" });
    const c2 = await closeStudy(a, { studyKey: k, trials: 20, actor: "test", note: "duplicate close" });
    expect(c1.status).toBe("CLOSED");
    expect(c2.status).toBe("ALREADY_CLOSED");
    expect(await total()).toBe(before + 20);
    // The other study committed 11 trials after this one froze its prior: reported, not hidden.
    expect(c1.concurrentTrials).toBeGreaterThanOrEqual(11);
    const reopened = await openStudy(a, { studyKey: k, actor: "test", note: "after close" });
    expect(reopened).toMatchObject({ status: "ALREADY_CLOSED", priorTrials: first.priorTrials, closedTrials: 20 });
    expect((await rowsFor(k)).length).toBe(2);
  });

  it("two processes opening the same study at once write one open row and see one prior", async () => {
    const k = key("race-open");
    const wait = barrier(2);
    const [x, y] = await Promise.all([a, b].map(async (db) => (await wait(), openStudy(db, { studyKey: k, actor: "test", note: "race" }))));
    expect([x!.status, y!.status].sort()).toEqual(["ALREADY_OPEN", "OPENED"]);
    expect(x!.priorTrials).toBe(y!.priorTrials);
    const wait2 = barrier(2);
    const before = await total();
    const closes = await Promise.all([a, b].map(async (db) => (await wait2(), closeStudy(db, { studyKey: k, trials: 9, actor: "test", note: "race" }))));
    expect(closes.map((c) => c.status).sort()).toEqual(["ALREADY_CLOSED", "CLOSED"]);
    expect(await total()).toBe(before + 9);
    expect((await rowsFor(k)).length).toBe(2);
  });

  it("concurrent different studies are serialised and the later close reports the earlier one's trials", async () => {
    const [k1, k2] = [key("conc-1"), key("conc-2")];
    const wait = barrier(2);
    const [o1, o2] = await Promise.all([[a, k1], [b, k2]].map(async ([db, k]) => (await wait(), openStudy(db as PrismaClient, { studyKey: k as string, actor: "test", note: "concurrent" }))));
    expect(o1!.priorTrials).toBe(o2!.priorTrials);
    await closeStudy(a, { studyKey: k1, trials: 50, actor: "test", note: "first" });
    const late = await closeStudy(b, { studyKey: k2, trials: 5, actor: "test", note: "second" });
    expect(late.concurrentTrials).toBeGreaterThanOrEqual(50);
  });

  it("database outage before opening: the open throws, so the CLI computes and prints nothing", async () => {
    const down = new PrismaClient({ datasources: { db: { url: "postgresql://nobody@127.0.0.1:1/odin_test_down?connect_timeout=2" } } });
    try {
      const k = key("outage-before");
      await expect(openStudy(down, { studyKey: k, actor: "test", note: "outage" })).rejects.toThrow();
      expect((await rowsFor(k)).length).toBe(0);
    } finally {
      await down.$disconnect();
    }
  }, 30_000);

  it("database outage after opening: the close throws (nothing printed) and the open stays visible", async () => {
    const k = key("outage-after");
    await openStudy(a, { studyKey: k, actor: "test", note: "outage after open" });
    const down = new PrismaClient({ datasources: { db: { url: "postgresql://nobody@127.0.0.1:1/odin_test_down?connect_timeout=2" } } });
    try {
      await expect(closeStudy(down, { studyKey: k, trials: 3, actor: "test", note: "never lands" })).rejects.toThrow();
    } finally {
      await down.$disconnect();
    }
    expect((await openStudies(a)).map((s) => s.studyKey)).toContain(k);
  }, 30_000);

  it("refuses a close for a study that was never opened, and malformed keys or counts", async () => {
    await expect(closeStudy(a, { studyKey: key("never-opened"), trials: 1, actor: "test", note: "x" })).rejects.toThrow(/never opened/);
    await expect(openStudy(a, { studyKey: "not-a-hash", actor: "test", note: "x" })).rejects.toThrow(/64-hex/);
    const k = key("bad-count");
    await openStudy(a, { studyKey: k, actor: "test", note: "x" });
    await expect(closeStudy(a, { studyKey: k, trials: -1, actor: "test", note: "x" })).rejects.toThrow(/non-negative/);
    await expect(closeStudy(a, { studyKey: k, trials: 1.5, actor: "test", note: "x" })).rejects.toThrow(/non-negative/);
  });

  it("a supplied prior below the frozen ledger count is ignored (F06)", async () => {
    const opened = await openStudy(a, { studyKey: key("f06"), actor: "test", note: "f06" });
    expect(resolvePriorTrials(0, opened.priorTrials).priorTrials).toBe(opened.priorTrials);
    expect(resolvePriorTrials(opened.priorTrials + 1_000, opened.priorTrials).priorTrials).toBe(opened.priorTrials + 1_000);
  });

  it("the ledger rows cannot be edited or deleted afterwards (append-only trigger)", async () => {
    const k = key("immutable");
    await openStudy(a, { studyKey: k, actor: "test", note: "immutable" });
    const [row] = await rowsFor(k);
    await expect(a.researchTrialLedger.update({ where: { id: row!.id }, data: { trials: 0 } })).rejects.toThrow();
    await expect(a.researchTrialLedger.delete({ where: { id: row!.id } })).rejects.toThrow();
  });
});
