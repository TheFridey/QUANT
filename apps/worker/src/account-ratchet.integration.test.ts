import { PrismaClient } from "@odin/shared/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySessionRoll, ratchetHighWaterMark } from "./account-ratchet.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));
const id = "account-ratchet-test";

describe.skipIf(!enabled)("late-writer guards on the paper account (Postgres)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });

  beforeEach(async () => {
    await prisma.paperAccount.deleteMany({ where: { id } });
    await prisma.paperAccount.create({ data: { id, cashUsd: "100", startingBalanceUsd: "100", highWaterMarkUsd: null } });
  });

  afterAll(async () => {
    await prisma.paperAccount.deleteMany({ where: { id } });
    await prisma.$disconnect();
  });

  const row = () => prisma.paperAccount.findUniqueOrThrow({ where: { id } });

  it("sets an empty mark, raises it, and refuses to lower it for a late writer", async () => {
    await ratchetHighWaterMark(prisma, id, "100.5");
    expect((await row()).highWaterMarkUsd?.toString()).toBe("100.5");
    await ratchetHighWaterMark(prisma, id, "120.25");
    expect((await row()).highWaterMarkUsd?.toString()).toBe("120.25");
    await ratchetHighWaterMark(prisma, id, "110");
    expect((await row()).highWaterMarkUsd?.toString()).toBe("120.25");
  });

  it("applies a first roll, then refuses a late roll that read an older session", async () => {
    const monday = new Date("2026-11-09T00:00:00Z");
    const tuesday = new Date("2026-11-10T00:00:00Z");
    expect(await applySessionRoll(prisma, id, null, { sessionStartedAt: monday, sessionStartEquityUsd: "100", sessionLowEquityUsd: "100" })).toBe(true);
    expect(await applySessionRoll(prisma, id, monday, { sessionStartedAt: tuesday, sessionStartEquityUsd: "90", sessionLowEquityUsd: "90" })).toBe(true);
    // A stage that read Monday's session and finishes late must not rewrite Tuesday's.
    expect(await applySessionRoll(prisma, id, monday, { sessionStartedAt: tuesday, sessionStartEquityUsd: "95", sessionLowEquityUsd: "95" })).toBe(false);
    const account = await row();
    expect(account.sessionStartedAt?.toISOString()).toBe(tuesday.toISOString());
    expect(account.sessionStartEquityUsd?.toString()).toBe("90");
    expect(account.sessionLowEquityUsd?.toString()).toBe("90");
  });
});
