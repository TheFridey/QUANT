/**
 * OPERATION INTEGRITY F02: revocation status that cannot be established must never mean "not revoked".
 *
 * These tests use real ioredis clients over real TCP sockets against a small in-process RESP stub
 * (Docker/Redis is not required). The stub is shared between two freshly imported module instances,
 * which stands in for two API processes (or one process before and after a restart): neither shares
 * in-memory revocation state with the other, only the store.
 */
import { createServer, type Server, type Socket as NetSocket } from "node:net";
import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

type RevocationModule = typeof import("./token-revocation.js");
type AuthModule = typeof import("./auth.service.js");

/** Minimal RESP server: INFO, GET, SET … PX, plus injected read failures. */
class RespStub {
  readonly store = new Map<string, string>();
  failReads = false;
  commands: string[] = [];
  private server: Server | null = null;
  private sockets = new Set<NetSocket>();
  port = 0;

  async start(port = 0): Promise<number> {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const parsed = parseCommand(buffer);
          if (!parsed) break;
          buffer = buffer.slice(parsed.consumed);
          socket.write(this.reply(parsed.args));
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    const address = this.server.address();
    this.port = typeof address === "object" && address ? address.port : port;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  private reply(args: string[]): string {
    const name = (args[0] ?? "").toUpperCase();
    this.commands.push(name);
    if (name === "INFO") return bulk("# Server\r\nloading:0\r\n");
    if (name === "GET") {
      if (this.failReads) return "-ERR injected read failure\r\n";
      const value = this.store.get(args[1] ?? "");
      return value === undefined ? "$-1\r\n" : bulk(value);
    }
    if (name === "SET") {
      this.store.set(args[1] ?? "", args[2] ?? "");
      return "+OK\r\n";
    }
    if (name === "QUIT") return "+OK\r\n";
    return "+OK\r\n";
  }
}

function bulk(value: string): string {
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

function parseCommand(buffer: string): { args: string[]; consumed: number } | null {
  if (!buffer.startsWith("*")) return null;
  let cursor = buffer.indexOf("\r\n");
  if (cursor < 0) return null;
  const count = Number(buffer.slice(1, cursor));
  cursor += 2;
  const args: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const end = buffer.indexOf("\r\n", cursor);
    if (end < 0) return null;
    const length = Number(buffer.slice(cursor + 1, end));
    const start = end + 2;
    if (buffer.length < start + length + 2) return null;
    args.push(buffer.slice(start, start + length));
    cursor = start + length + 2;
  }
  return { args, consumed: cursor };
}

const loaded: RevocationModule[] = [];

/** A fresh "process": new module instances, no shared memory, REDIS_URL read anew. */
async function freshProcess(redisUrl: string | undefined): Promise<{ revocation: RevocationModule; auth: AuthModule }> {
  if (redisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = redisUrl;
  vi.resetModules();
  const revocation = await import("./token-revocation.js");
  const auth = await import("./auth.service.js");
  loaded.push(revocation);
  return { revocation, auth };
}

function authService(auth: AuthModule, payload: Record<string, unknown>) {
  const jwt = { signAsync: async () => "signed", verifyAsync: async () => payload };
  return new auth.AuthService({ user: { findUnique: async () => null } } as never, jwt as never);
}

const validPayload = (jti: string) => ({ sub: "u1", email: "admin@odin.local", role: "ADMIN", jti, exp: Math.floor(Date.now() / 1000) + 600 });

afterEach(async () => {
  for (const module of loaded.splice(0)) await module.closeTokenRevocationForTests();
  delete process.env.REDIS_URL;
});

describe("revocation fails closed when Redis is configured but unreachable (F02)", () => {
  it("a verifier with no local memory refuses a signed token instead of accepting it", async () => {
    const { revocation, auth } = await freshProcess("redis://127.0.0.1:1");
    await expect(revocation.isTokenRevoked("jti-unknown")).rejects.toBeInstanceOf(revocation.RevocationStatusUnavailableError);
    const service = authService(auth, validPayload("jti-unknown"));
    await expect(service.verify("token")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("stays closed during active backoff without reconnecting per request", async () => {
    const { revocation, auth } = await freshProcess("redis://127.0.0.1:1");
    await expect(revocation.isTokenRevoked("jti-a")).rejects.toThrow();
    const first = revocation.tokenRevocationBackoffForTests();
    expect(first.failures).toBe(1);
    expect(first.downUntil).toBeGreaterThan(Date.now());
    const service = authService(auth, validPayload("jti-b"));
    const started = Date.now();
    for (let index = 0; index < 20; index += 1) await expect(service.verify("token")).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(Date.now() - started).toBeLessThan(200);
    expect(revocation.tokenRevocationBackoffForTests().failures).toBe(1);
  });

  it("still rejects a locally revoked token as revoked (401) during the outage", async () => {
    const { revocation, auth } = await freshProcess("redis://127.0.0.1:1");
    expect(await revocation.revokeToken("jti-local", Date.now() + 60_000)).toBe(false);
    expect(await revocation.isTokenRevoked("jti-local")).toBe(true);
    const service = authService(auth, validPayload("jti-local"));
    await expect(service.verify("token")).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("fails closed when Redis is reachable but the read errors", async () => {
    const stub = new RespStub();
    const port = await stub.start();
    try {
      stub.failReads = true;
      const { revocation, auth } = await freshProcess(`redis://127.0.0.1:${port}`);
      await expect(revocation.isTokenRevoked("jti-read")).rejects.toBeInstanceOf(revocation.RevocationStatusUnavailableError);
      await expect(authService(auth, validPayload("jti-read")).verify("token")).rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      await stub.stop();
    }
  });

  it("keeps intentionally unconfigured single-process mode distinct: memory is the store", async () => {
    const { revocation, auth } = await freshProcess(undefined);
    expect(await revocation.isTokenRevoked("jti-none")).toBe(false);
    await expect(authService(auth, validPayload("jti-none")).verify("token")).resolves.toMatchObject({ id: "u1" });
    expect(await revocation.revokeToken("jti-none", Date.now() + 60_000)).toBe(true);
    await expect(authService(auth, validPayload("jti-none")).verify("token")).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe("cross-process and restart semantics against a shared store (F02)", () => {
  it("a revocation made in one process is enforced by another with no local memory", async () => {
    const stub = new RespStub();
    const port = await stub.start();
    try {
      const a = await freshProcess(`redis://127.0.0.1:${port}`);
      expect(await a.revocation.revokeToken("jti-shared", Date.now() + 60_000)).toBe(true);
      const b = await freshProcess(`redis://127.0.0.1:${port}`);
      expect(await b.revocation.isTokenRevoked("jti-shared")).toBe(true);
      expect(await b.revocation.isTokenRevoked("jti-other")).toBe(false);
    } finally {
      await stub.stop();
    }
  });

  it("queued revocations survive the outage and are flushed on recovery before any read is answered", async () => {
    const stub = new RespStub();
    const port = await stub.start();
    await stub.stop(); // Redis goes down; the port is now closed.
    const a = await freshProcess(`redis://127.0.0.1:${port}`);
    expect(await a.revocation.revokeToken("jti-queued", Date.now() + 60_000)).toBe(false);
    expect(a.revocation.tokenRevocationBackoffForTests().pendingWrites).toBe(1);
    // Another process during the outage must not accept the token.
    const b = await freshProcess(`redis://127.0.0.1:${port}`);
    await expect(b.revocation.isTokenRevoked("jti-queued")).rejects.toBeInstanceOf(b.revocation.RevocationStatusUnavailableError);

    await stub.start(port); // Redis recovers.
    try {
      a.revocation.clearRedisBackoffForTests();
      // Process A's next read flushes the queue first.
      expect(await a.revocation.isTokenRevoked("jti-anything")).toBe(false);
      expect(a.revocation.tokenRevocationBackoffForTests().pendingWrites).toBe(0);
      expect(stub.store.get("odin:jwt:revoked:jti-queued")).toBe("1");
      // A restarted process (fresh memory) now sees the revocation.
      const restarted = await freshProcess(`redis://127.0.0.1:${port}`);
      expect(await restarted.revocation.isTokenRevoked("jti-queued")).toBe(true);
    } finally {
      await stub.stop();
    }
  });

  it("does not drop queued writes when the flush itself fails", async () => {
    const stub = new RespStub();
    const port = await stub.start();
    await stub.stop();
    const a = await freshProcess(`redis://127.0.0.1:${port}`);
    expect(await a.revocation.revokeToken("jti-keep", Date.now() + 60_000)).toBe(false);
    a.revocation.clearRedisBackoffForTests();
    await expect(a.revocation.isTokenRevoked("jti-x")).rejects.toThrow();
    expect(a.revocation.tokenRevocationBackoffForTests().pendingWrites).toBe(1);
  });
});

describe("logout reports durability and works during an outage (F02)", () => {
  it("records the local revocation and reports 503 when Redis did not confirm", async () => {
    const { revocation, auth } = await freshProcess("redis://127.0.0.1:1");
    const service = authService(auth, validPayload("jti-logout"));
    await expect(service.logout("token")).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await revocation.isTokenRevoked("jti-logout")).toBe(true);
  });

  it("reports ok when the revocation is durable", async () => {
    const stub = new RespStub();
    const port = await stub.start();
    try {
      const { auth } = await freshProcess(`redis://127.0.0.1:${port}`);
      await expect(authService(auth, validPayload("jti-ok")).logout("token")).resolves.toEqual({ ok: true });
      expect(stub.store.get("odin:jwt:revoked:jti-ok")).toBe("1");
    } finally {
      await stub.stop();
    }
  });

  it("logout is reachable without the global guard so an outage cannot block the local revocation", async () => {
    const { Reflector } = await import("@nestjs/core");
    const { AuthController } = await import("./auth.controller.js");
    const { IS_PUBLIC } = await import("./http.js");
    const handler = AuthController.prototype.logout;
    expect(new Reflector().get<boolean>(IS_PUBLIC, handler)).toBe(true);
  });
});
