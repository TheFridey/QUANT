import { BadRequestException, CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ZodError, type ZodType } from "zod";
import { AuthService, type AuthUser } from "./auth.service.js";

export const IS_PUBLIC = "odin:public";
export const Public = () => SetMetadata(IS_PUBLIC, true);

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException({
      error: "VALIDATION",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

export function zodMessage(error: ZodError): { error: string; issues: Array<{ path: string; message: string }> } {
  return {
    error: "VALIDATION",
    issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  };
}

export type RequestWithUser = Request & { user?: AuthUser; id?: string };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new UnauthorizedException("Authentication required");
    request.user = await this.auth.verify(header.slice("Bearer ".length));
    return true;
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (request.user?.role !== "ADMIN") throw new ForbiddenException("Admin role required");
    return true;
  }
}
