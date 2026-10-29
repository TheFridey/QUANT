import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { verifyPassword } from "@odin/shared/password";
import { PrismaClient } from "@odin/shared/db";
import { isTokenRevoked, revokeToken, tokenFingerprint } from "./token-revocation.js";

export type AuthUser = { id: string; email: string; role: string };

/**
 * Login rate limit is per-process in-memory keyed by `request.ip`.
 * Behind a reverse proxy this is only proxy-aware if the process trusts
 * `X-Forwarded-For` (not enabled by default). Shared multi-replica limiting
 * is out of single-operator scope — document, do not pretend otherwise (D25).
 */
const attempts = new Map<string, { count: number; resetAt: number }>();

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
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
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
    const current = attempts.get(ip);
    const now = Date.now();
    if (!current || current.resetAt < now) {
      attempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
      return;
    }
    current.count += 1;
  }
}
