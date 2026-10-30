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
          tradingEnvironment: config.tradingEnvironment ?? "MARKET_DATA_PAPER",
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
  /** Listen address; loopback unless API_HOST is set (audit M4). */
  apiHost: string;
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
    API_HOST: z.string().min(1).default("127.0.0.1"),
    DATA_MODE: z.enum(["live", "replay", "demo"]).default("live"),
    MARKET_POLL_MS: z.coerce.number().int().min(5000).max(300000).default(20000),
    BIRDEYE_API_KEY: z.string().optional(),
    NODE_ENV: z.string().optional(),
  });
  const env = schema.parse(process.env);
  assertDeploymentSecrets({ jwtSecret: env.JWT_SECRET, adminPassword: env.ADMIN_PASSWORD, webOrigin: env.WEB_ORIGIN });
  return {
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    jwtSecret: env.JWT_SECRET,
    adminEmail: env.ADMIN_EMAIL,
    adminPassword: env.ADMIN_PASSWORD,
    webOrigin: env.WEB_ORIGIN,
    apiPort: env.API_PORT,
    apiHost: env.API_HOST,
    dataMode: env.DATA_MODE,
    marketPollMs: env.MARKET_POLL_MS,
    birdeyeApiKey: env.BIRDEYE_API_KEY && env.BIRDEYE_API_KEY.length > 0 ? env.BIRDEYE_API_KEY : undefined,
  };
}

/** Sample secrets shipped in .env.example, CI and docs. Never acceptable off loopback. */
const SAMPLE_JWT_SECRETS = ["ci-jwt-secret-not-for-production"];
const SAMPLE_JWT_PATTERNS = [/replace-with/i, /^local-/i];
const SAMPLE_ADMIN_PASSWORDS = ["odin-paper-dev"];
export const MIN_SHARED_JWT_SECRET_LENGTH = 32;

/** True when the web origin is this machine only (localhost, 127.0.0.0/8 or ::1). */
export function isLoopbackOrigin(webOrigin: string): boolean {
  try {
    const host = new URL(webOrigin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/**
 * Audit M7: whenever the UI is reachable beyond loopback, refuse weak or sample secrets regardless
 * of NODE_ENV (a forgotten NODE_ENV must not ship the sample admin password). Loopback-only
 * development and CI keep working with the samples.
 */
export function assertDeploymentSecrets(input: { jwtSecret: string; adminPassword: string; webOrigin: string }): void {
  if (isLoopbackOrigin(input.webOrigin)) return;
  const problems: string[] = [];
  if (input.jwtSecret.length < MIN_SHARED_JWT_SECRET_LENGTH) {
    problems.push(`JWT_SECRET must be at least ${MIN_SHARED_JWT_SECRET_LENGTH} characters`);
  }
  if (SAMPLE_JWT_SECRETS.includes(input.jwtSecret) || SAMPLE_JWT_PATTERNS.some((pattern) => pattern.test(input.jwtSecret))) {
    problems.push("JWT_SECRET is a published sample value");
  }
  if (SAMPLE_ADMIN_PASSWORDS.includes(input.adminPassword)) {
    problems.push("ADMIN_PASSWORD is the published sample value");
  }
  if (problems.length > 0) {
    throw new Error(`REFUSING_DEFAULT_SECRETS: WEB_ORIGIN is not loopback and ${problems.join("; ")}`);
  }
}

export const prismaTypes = { Prisma };
export { createPrismaClient };
