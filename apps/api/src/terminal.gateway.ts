import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { WebSocketGateway, WebSocketServer, type OnGatewayConnection } from "@nestjs/websockets";
import { TERMINAL_CHANNEL } from "@odin/shared";
import IORedis from "ioredis";
import type { Server, Socket } from "socket.io";
import { AuthService } from "./auth.service.js";

@WebSocketGateway({
  cors: { origin: true, credentials: false },
})
export class TerminalGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  constructor(private readonly auth: AuthService) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = client.handshake.auth?.token;
    try {
      await this.auth.verify(typeof token === "string" ? token : "");
    } catch {
      client.disconnect(true);
    }
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
