import { Body, Controller, Get, Post, Req } from "@nestjs/common";
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

  @Get("me")
  me(@Req() request: RequestWithUser) {
    return { user: request.user };
  }
}
