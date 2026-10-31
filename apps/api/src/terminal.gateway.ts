import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import {
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayInit,
} from "@nestjs/websockets";
import { TERMINAL_CHANNEL } from "@odin/shared";
import IORedis from "ioredis";
import type { Server, Socket } from "socket.io";
import { AuthService } from "./auth.service.js";
import { allowedWebOrigins, isAllowedSocketOrigin } from "./socket-origins.js";

const SOCKET_REVALIDATE_MS = 60_000;
/** Only sockets that passed handshake authentication join this room; terminal events go nowhere else. */
export const OPERATOR_ROOM = "operators";

type SocketAuth = Pick<AuthService, "verify">;

/**
 * Audit M6: authenticate in the Socket.IO handshake middleware, so an unauthenticated or
 * cross-origin client is rejected before `connection` fires and can never receive an event.
 */
export function socketAuthMiddleware(auth: SocketAuth) {
  return (socket: Socket, next: (error?: Error) => void): void => {
    const originHeader = socket.handshake.headers.origin;
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (!isAllowedSocketOrigin(origin)) {
      next(new Error("ORIGIN_NOT_ALLOWED"));
      return;
    }
    const token = socket.handshake.auth?.token;
    const raw = typeof token === "string" ? token : "";
    auth
      .verify(raw)
      .then(() => {
        (socket.data as { token?: string }).token = raw;
        next();
      })
      .catch(() => next(new Error("UNAUTHORISED")));
  };
}

@WebSocketGateway({
  cors: {
    origin: allowedWebOrigins(),
    credentials: false,
  },
})
export class TerminalGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  constructor(private readonly auth: AuthService) {}

  afterInit(server: Server): void {
    server.use(socketAuthMiddleware(this.auth));
  }

  async handleConnection(client: Socket): Promise<void> {
    const raw = (client.data as { token?: string }).token;
    // Defence in depth: the middleware sets the token; anything without one never joins the room.
    if (typeof raw !== "string") {
      client.disconnect(true);
      return;
    }
    await client.join(OPERATOR_ROOM);

    // Re-check JWT expiry + revocation while the socket stays open (D25).
    const interval = setInterval(() => {
      void this.auth
        .verify(raw)
        .then(() => undefined)
        .catch(() => {
          clearInterval(interval);
          client.disconnect(true);
        });
    }, SOCKET_REVALIDATE_MS);
    client.on("disconnect", () => clearInterval(interval));
  }

  publish(payload: unknown): void {
    this.server?.to(OPERATOR_ROOM).emit("terminal", payload);
  }
}

@Injectable()
export class TerminalFanout implements OnModuleInit, OnModuleDestroy {
  private readonly redis: IORedis;

  constructor(private readonly gateway: TerminalGateway) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is required");
    this.redis = new IORedis(url);
    this.redis.on("error", () => undefined);
  }

  async onModuleInit(): Promise<void> {
    await this.redis.subscribe(TERMINAL_CHANNEL);
    this.redis.on("message", (_channel, message) => {
      try {
        this.gateway.publish(JSON.parse(message) as unknown);
      } catch {
        return;
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
