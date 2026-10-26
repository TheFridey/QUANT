import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { verifyPassword } from "@odin/shared/password";
import { PrismaClient } from "@odin/shared/db";

export type AuthUser = { id: string; email: string; role: string };

const attempts = new Map<string, { count: number; resetAt: number }>();

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
    const token = await this.jwt.signAsync({ sub: user.id, email: user.email, role: user.role });
    return { token, user: { email: user.email, role: user.role } };
  }

  async verify(token: string): Promise<AuthUser> {
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: string; email?: string; role?: string }>(token);
      if (!payload.sub || !payload.email || !payload.role) throw new Error("incomplete token");
      return { id: payload.sub, email: payload.email, role: payload.role };
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
