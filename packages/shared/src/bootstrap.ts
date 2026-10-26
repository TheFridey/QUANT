import { hashPassword } from "./password.js";
import { createPrismaClient, Prisma, PrismaClient, toJson } from "./db.js";
import { DEFAULT_STRATEGY, parseStrategyConfig, type StrategyConfig } from "./strategy.js";
import { usd, d } from "./money.js";

export async function ensureFoundation(
  prisma: PrismaClient,
  input: { email: string; password: string; config?: StrategyConfig },
): Promise<void> {
  const email = input.email.trim().toLowerCase();
  const config = input.config ?? parseStrategyConfig(DEFAULT_STRATEGY);
  const passwordHash = await hashPassword(input.password);
  const starting = usd(d(config.startingBalanceUsd));

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(641001)`;
    const user = await tx.user.findUnique({ where: { email } });
    if (!user) {
      await tx.user.create({ data: { email, passwordHash, role: "ADMIN" } });
    }
    const engine = await tx.engineControl.findUnique({ where: { id: "primary" } });
    if (!engine) {
      await tx.engineControl.create({
        data: { id: "primary", status: "STOPPED", config: toJson(config) },
      });
    }
    const account = await tx.paperAccount.findUnique({ where: { id: "primary" } });
    if (!account) {
      await tx.paperAccount.create({
        data: {
          id: "primary",
          cashUsd: starting,
          startingBalanceUsd: starting,
        },
      });
    }
    const opening = await tx.ledgerEntry.findFirst({
      where: { accountId: "primary", type: "OPENING_BALANCE" },
    });
    if (!opening) {
      await tx.ledgerEntry.create({
        data: {
          accountId: "primary",
          type: "OPENING_BALANCE",
          amountUsd: starting,
          affectsCash: true,
          note: "Configured paper starting balance",
        },
      });
    }
  });
}

export async function loadEnvConfig(): Promise<{
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  adminEmail: string;
  adminPassword: string;
  webOrigin: string;
  apiPort: number;
  dataMode: "live" | "replay" | "demo";
  marketPollMs: number;
  birdeyeApiKey: string | undefined;
}> {
  const { z } = await import("zod");
  const schema = z.object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    JWT_SECRET: z.string().min(16),
    ADMIN_EMAIL: z.string().min(3),
    ADMIN_PASSWORD: z.string().min(8),
    WEB_ORIGIN: z.string().url(),
    API_PORT: z.coerce.number().int().default(4318),
    DATA_MODE: z.enum(["live", "replay", "demo"]).default("live"),
    MARKET_POLL_MS: z.coerce.number().int().min(5000).max(300000).default(20000),
    BIRDEYE_API_KEY: z.string().optional(),
    NODE_ENV: z.string().optional(),
  });
  const env = schema.parse(process.env);
  if (env.NODE_ENV === "production") {
    if (env.JWT_SECRET.includes("replace-with") || env.ADMIN_PASSWORD === "odin-paper-dev") {
      throw new Error("REFUSING_DEFAULT_SECRETS");
    }
  }
  return {
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    jwtSecret: env.JWT_SECRET,
    adminEmail: env.ADMIN_EMAIL,
    adminPassword: env.ADMIN_PASSWORD,
    webOrigin: env.WEB_ORIGIN,
    apiPort: env.API_PORT,
    dataMode: env.DATA_MODE,
    marketPollMs: env.MARKET_POLL_MS,
    birdeyeApiKey: env.BIRDEYE_API_KEY && env.BIRDEYE_API_KEY.length > 0 ? env.BIRDEYE_API_KEY : undefined,
  };
}

export const prismaTypes = { Prisma };
export { createPrismaClient };
