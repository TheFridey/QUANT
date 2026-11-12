import { Body, Controller, Get, Headers, Post, Req, UnauthorizedException } from "@nestjs/common";
import { loginSchema } from "@odin/shared";
import { AuthService } from "./auth.service.js";
import { Public, parseBody, type RequestWithUser } from "./http.js";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("login")
  login(@Body() body: unknown, @Req() request: RequestWithUser) {
    const input = parseBody(loginSchema, body);
    return this.auth.login(input.email, input.password, request.ip ?? "unknown");
  }

  // F02: logout checks the signature itself and must not depend on the revocation store being readable,
  // or an outage would stop it recording the local revocation. It reports 503 when Redis did not confirm.
  @Public()
  @Post("logout")
  logout(@Headers("authorization") authorization: string | undefined) {
    if (!authorization?.startsWith("Bearer ")) throw new UnauthorizedException("Authentication required");
    return this.auth.logout(authorization.slice("Bearer ".length));
  }

  @Get("me")
  me(@Req() request: RequestWithUser) {
    return { user: request.user };
  }
}
