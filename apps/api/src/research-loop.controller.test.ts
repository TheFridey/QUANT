import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { AdminGuard } from "./http.js";
import { ResearchLoopController } from "./research-loop.controller.js";

describe("ASCEND-08 research loop API", () => {
  it("guards every route with ADMIN at the controller level", () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ResearchLoopController) as unknown[];
    expect(guards).toContain(AdminGuard);
  });

  it("AdminGuard refuses a non-admin user", () => {
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ user: { role: "VIEWER", email: "v@odin.local" } }) }),
    } as unknown as ExecutionContext;
    expect(() => new AdminGuard().canActivate(context)).toThrow(ForbiddenException);
  });
});
