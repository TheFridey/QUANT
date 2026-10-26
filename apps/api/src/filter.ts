import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";
import { apiLog } from "./logger.js";
import { zodMessage, type RequestWithUser } from "./http.js";

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<RequestWithUser>();
    if (exception instanceof ZodError) {
      response.status(HttpStatus.BAD_REQUEST).json(zodMessage(exception));
      return;
    }
    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json({ error: exception.message, detail: exception.getResponse() });
      return;
    }
    const code = typeof exception === "object" && exception && "code" in exception ? String(exception.code) : "";
    if (code === "P2002") {
      response.status(HttpStatus.CONFLICT).json({ error: "Duplicate record" });
      return;
    }
    apiLog.error({ err: exception, requestId: request.id, path: request.path }, "request failed");
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: "Internal error", requestId: request.id ?? null });
  }
}
