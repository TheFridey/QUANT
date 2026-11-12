import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { Server, Socket } from "socket.io";
import type { AuthService } from "./auth.service.js";
import { OPERATOR_ROOM, TerminalGateway, socketAuthMiddleware } from "./terminal.gateway.js";

/** Audit M6: unauthenticated sockets are rejected in the handshake and never receive terminal events. */

function fakeSocket(input: { token?: unknown; origin?: string }) {
  return {
    handshake: { headers: { origin: input.origin }, auth: input.token === undefined ? {} : { token: input.token } },
    data: {} as Record<string, unknown>,
    join: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    on: vi.fn(),
  } as unknown as Socket & { join: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; data: Record<string, unknown> };
}

const auth = {
  verify: vi.fn(async (token: string) => {
    if (token !== "good-token") throw new Error("invalid");
    return { sub: "operator" };
  }),
} as unknown as AuthService;

function runMiddleware(socket: Socket): Promise<Error | undefined> {
  return new Promise((resolve) => socketAuthMiddleware(auth)(socket, (error) => resolve(error)));
}

describe("terminal socket handshake auth", () => {
  it("rejects a socket with no token before connection", async () => {
    const socket = fakeSocket({});
    expect((await runMiddleware(socket))?.message).toBe("UNAUTHORISED");
    expect(socket.data.token).toBeUndefined();
  });

  it("rejects an invalid or revoked token", async () => {
    expect((await runMiddleware(fakeSocket({ token: "stolen" })))?.message).toBe("UNAUTHORISED");
    expect((await runMiddleware(fakeSocket({ token: 42 })))?.message).toBe("UNAUTHORISED");
  });

  it("rejects a disallowed browser origin even with a valid token", async () => {
    expect((await runMiddleware(fakeSocket({ token: "good-token", origin: "https://evil.example" })))?.message).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("admits a valid token and joins only that socket to the operator room", async () => {
    const socket = fakeSocket({ token: "good-token", origin: "http://127.0.0.1:4317" });
    expect(await runMiddleware(socket)).toBeUndefined();
    const gateway = new TerminalGateway(auth);
    await gateway.handleConnection(socket);
    expect(socket.join).toHaveBeenCalledWith(OPERATOR_ROOM);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it("disconnects a connection that bypassed the middleware without joining the room", async () => {
    const socket = fakeSocket({ token: "good-token" });
    const gateway = new TerminalGateway(auth);
    await gateway.handleConnection(socket);
    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it("publishes terminal events only to the authenticated room", () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const broadcast = vi.fn();
    const gateway = new TerminalGateway(auth);
    gateway.server = { to, emit: broadcast } as unknown as Server;
    gateway.publish({ type: "stage" });
    expect(to).toHaveBeenCalledWith(OPERATOR_ROOM);
    expect(emit).toHaveBeenCalledWith("terminal", { type: "stage" });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("refuses the handshake as AUTH_UNAVAILABLE when revocation status cannot be established (F02)", async () => {
    const unavailable = {
      verify: vi.fn(async () => {
        throw new ServiceUnavailableException("Session check unavailable");
      }),
    } as unknown as AuthService;
    const socket = fakeSocket({ token: "good-token", origin: "http://127.0.0.1:4317" });
    const error = await new Promise<Error | undefined>((resolve) => socketAuthMiddleware(unavailable)(socket, (e) => resolve(e)));
    expect(error?.message).toBe("AUTH_UNAVAILABLE");
    expect(socket.data.token).toBeUndefined();
  });

  it("disconnects an open socket when revalidation cannot establish revocation status (F02)", async () => {
    vi.useFakeTimers();
    try {
      let unavailable = false;
      const flaky = {
        verify: vi.fn(async () => {
          if (unavailable) throw new ServiceUnavailableException("Session check unavailable");
          return { sub: "operator" };
        }),
      } as unknown as AuthService;
      const socket = fakeSocket({ token: "good-token" });
      socket.data.token = "good-token";
      await new TerminalGateway(flaky).handleConnection(socket);
      expect(socket.join).toHaveBeenCalledWith(OPERATOR_ROOM);
      unavailable = true;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("installs the middleware on the server at init", () => {
    const use = vi.fn();
    new TerminalGateway(auth).afterInit({ use } as unknown as Server);
    expect(use).toHaveBeenCalledTimes(1);
  });
});
