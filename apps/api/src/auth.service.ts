import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { hashPassword, verifyPassword } from "@odin/shared/password";
import { PrismaClient } from "@odin/shared/db";
import { isTokenRevoked, revokeToken, tokenFingerprint } from "./token-revocation.js";

export type AuthUser = { id: string; email: string; role: string };

/**
 * Login rate limit is per-process in-memory keyed by `request.ip`.
 * Express `trust proxy` is NOT enabled, so behind a reverse proxy every client shares the proxy's
 * IP and one bad actor can lock out the operator; enable `trust proxy` only for a known proxy hop
 * (RUNBOOKS). Shared multi-replica limiting is out of single-operator scope (D25).
 */
const attempts = new Map<string, { count: number; resetAt: number }>();
/** Audit L1: bound the map so a flood of distinct IPs cannot grow it without limit. */
const MAX_TRACKED_IPS = 10_000;

/** Prune expired entries on every write; if still full, drop the oldest-expiring entries. */
export function pruneLoginAttempts(now = Date.now()): void {
  for (const [ip, entry] of attempts) {
    if (entry.resetAt <= now) attempts.delete(ip);
  }
  if (attempts.size < MAX_TRACKED_IPS) return;
  const oldest = [...attempts.entries()].sort(([, a], [, b]) => a.resetAt - b.resetAt);
  for (const [ip] of oldest.slice(0, attempts.size - MAX_TRACKED_IPS + 1)) attempts.delete(ip);
}

/** Test helper. */
export function loginAttemptsForTests(): Map<string, { count: number; resetAt: number }> {
  return attempts;
}

/** A real scrypt hash, verified for unknown emails so the response time does not reveal which emails exist. */
let dummyHash: Promise<string> | null = null;
function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword("odin-dummy-password-for-timing");
  return dummyHash;
}

type JwtPayload = {
  sub?: string;
  email?: string;
  role?: string;
  jti?: string;
  exp?: number;
  iat?: number;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string, ip: string): Promise<{ token: string; user: { email: string; role: string } }> {
    this.assertNotLimited(ip);
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    // Audit L1: always run one scrypt verify, so unknown emails cost the same as wrong passwords.
    const valid = user ? await verifyPassword(password, user.passwordHash) : (await verifyPassword(password, await dummyPasswordHash()), false);
    if (!user || !valid) {
      this.recordFailure(ip);
      throw new UnauthorizedException("Invalid credentials");
    }
    attempts.delete(ip);
    const jti = randomUUID();
    const token = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
      jti,
    });
    return { token, user: { email: user.email, role: user.role } };
  }

  async logout(token: string): Promise<{ ok: true }> {
    const payload = await this.verifyPayload(token);
    const id = payload.jti ?? tokenFingerprint(token);
    const expMs = payload.exp ? payload.exp * 1000 : Date.now() + 12 * 60 * 60 * 1000;
    await revokeToken(id, expMs);
    return { ok: true };
  }

  async verify(token: string): Promise<AuthUser> {
    const payload = await this.verifyPayload(token);
    if (!payload.sub || !payload.email || !payload.role) throw new UnauthorizedException("Invalid session");
    const id = payload.jti ?? tokenFingerprint(token);
    if (await isTokenRevoked(id)) throw new UnauthorizedException("Session revoked");
    return { id: payload.sub, email: payload.email, role: payload.role };
  }

  private async verifyPayload(token: string): Promise<JwtPayload> {
    try {
      // JwtService.verifyAsync enforces signature + exp (Nest/jsonwebtoken defaults).
      return await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException("Invalid session");
    }
  }

  private assertNotLimited(ip: string): void {
    const entry = attempts.get(ip);
    if (entry && entry.resetAt > Date.now() && entry.count >= 8) {
      throw new UnauthorizedException("Too many login attempts");
    }
  }

  private recordFailure(ip: string): void {
    const now = Date.now();
    pruneLoginAttempts(now);
    const current = attempts.get(ip);
    if (!current || current.resetAt < now) {
      attempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
      return;
    }
    current.count += 1;
  }
}
