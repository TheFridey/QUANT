import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { WebSocketGateway, WebSocketServer, type OnGatewayConnection } from "@nestjs/websockets";
import { TERMINAL_CHANNEL } from "@odin/shared";
import IORedis from "ioredis";
import type { Server, Socket } from "socket.io";
import { AuthService } from "./auth.service.js";
import { allowedWebOrigins, isAllowedSocketOrigin } from "./socket-origins.js";

const SOCKET_REVALIDATE_MS = 60_000;

@WebSocketGateway({
  cors: {
    origin: allowedWebOrigins(),
    credentials: false,
  },
})
export class TerminalGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  constructor(private readonly auth: AuthService) {}

  async handleConnection(client: Socket): Promise<void> {
    const originHeader = client.handshake.headers.origin;
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (!isAllowedSocketOrigin(origin)) {
      client.disconnect(true);
      return;
    }

    const token = client.handshake.auth?.token;
    const raw = typeof token === "string" ? token : "";
    try {
      await this.auth.verify(raw);
    } catch {
      client.disconnect(true);
      return;
    }

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
    this.server?.emit("terminal", payload);
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
