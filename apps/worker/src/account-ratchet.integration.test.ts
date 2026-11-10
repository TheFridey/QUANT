import { PrismaClient } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ratchetHighWaterMark } from "./account-ratchet.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));
const id = "account-ratchet-test";

describe.skipIf(!enabled)("high-water mark ratchet (Postgres)", () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  beforeAll(async () => {
    await prisma.paperAccount.deleteMany({ where: { id } });
    await prisma.paperAccount.create({ data: { id, cashUsd: "100", startingBalanceUsd: "100", highWaterMarkUsd: null } });
  });

  afterAll(async () => {
    await prisma.paperAccount.deleteMany({ where: { id } });
    await prisma.$disconnect();
  });

  const hwm = async () => (await prisma.paperAccount.findUniqueOrThrow({ where: { id } })).highWaterMarkUsd?.toString();

  it("sets an empty mark, raises it, and refuses to lower it for a late writer", async () => {
    await ratchetHighWaterMark(prisma, id, "100.5");
    expect(await hwm()).toBe("100.5");
    await ratchetHighWaterMark(prisma, id, "120.25");
    expect(await hwm()).toBe("120.25");
    await ratchetHighWaterMark(prisma, id, "110");
    expect(await hwm()).toBe("120.25");
  });
});
