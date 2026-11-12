import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyCalls: string[] = [];
vi.mock("@odin/shared/password", () => ({
  hashPassword: vi.fn(async () => "dummy-hash"),
  verifyPassword: vi.fn(async (_password: string, stored: string) => {
    verifyCalls.push(stored);
    return stored === "real-hash" && _password === "right";
  }),
}));

// Point Redis at a closed port so revocation exercises the down path (audit L2).
process.env.REDIS_URL = "redis://127.0.0.1:1";

const { AuthService, loginAttemptsForTests, pruneLoginAttempts } = await import("./auth.service.js");
const { isTokenRevoked, resetTokenRevocationForTests, revokeToken, RevocationStatusUnavailableError, tokenRevocationBackoffForTests } = await import(
  "./token-revocation.js"
);

function service(users: Record<string, { id: string; email: string; role: string; passwordHash: string }>) {
  const prisma = { user: { findUnique: async ({ where }: { where: { email: string } }) => users[where.email] ?? null } };
  const jwt = { signAsync: async () => "signed", verifyAsync: async () => ({}) };
  return new AuthService(prisma as never, jwt as never);
}

describe("login hardening (audit L1)", () => {
  beforeEach(() => {
    verifyCalls.length = 0;
    loginAttemptsForTests().clear();
  });

  it("runs a scrypt verify for unknown emails so timing does not reveal which exist", async () => {
    const auth = service({});
    await expect(auth.login("nobody@odin.local", "guess", "10.0.0.1")).rejects.toThrow(/Invalid credentials/);
    expect(verifyCalls).toEqual(["dummy-hash"]);
  });

  it("still verifies real users against their own hash", async () => {
    const auth = service({ "admin@odin.local": { id: "u1", email: "admin@odin.local", role: "ADMIN", passwordHash: "real-hash" } });
    await expect(auth.login("admin@odin.local", "right", "10.0.0.2")).resolves.toMatchObject({ token: "signed" });
    expect(verifyCalls).toEqual(["real-hash"]);
  });

  it("prunes expired attempt entries when a failure is recorded", async () => {
    const attempts = loginAttemptsForTests();
    for (let index = 0; index < 50; index += 1) attempts.set(`stale-${index}`, { count: 3, resetAt: Date.now() - 1 });
    await expect(service({}).login("x@odin.local", "guess", "10.0.0.3")).rejects.toThrow();
    expect([...attempts.keys()]).toEqual(["10.0.0.3"]);
  });

  it("caps the number of tracked IPs", () => {
    const attempts = loginAttemptsForTests();
    const future = Date.now() + 60_000;
    for (let index = 0; index < 10_050; index += 1) attempts.set(`ip-${index}`, { count: 1, resetAt: future + index });
    pruneLoginAttempts();
    expect(attempts.size).toBeLessThan(10_000);
    expect(attempts.has("ip-10049")).toBe(true);
  });
});

describe("token revocation with Redis down (audit L2)", () => {
  beforeEach(() => resetTokenRevocationForTests());

  // F02: these previously asserted `false` (not revoked) while Redis was down, i.e. fail open.
  it("backs off after a failed connect instead of reconnecting on every request, failing closed", async () => {
    await expect(isTokenRevoked("jti-a")).rejects.toBeInstanceOf(RevocationStatusUnavailableError);
    const first = tokenRevocationBackoffForTests();
    expect(first.failures).toBe(1);
    expect(first.downUntil).toBeGreaterThan(Date.now());
    const started = Date.now();
    for (let index = 0; index < 20; index += 1) await expect(isTokenRevoked(`jti-${index}`)).rejects.toBeInstanceOf(RevocationStatusUnavailableError);
    expect(Date.now() - started).toBeLessThan(200);
    expect(tokenRevocationBackoffForTests().failures).toBe(1);
  });

  it("keeps revocation working from memory while Redis is down", async () => {
    await revokeToken("jti-revoked", Date.now() + 60_000);
    expect(await isTokenRevoked("jti-revoked")).toBe(true);
  });

  it("always tries the Redis write on revoke, reports it was not durable, and keeps it queued", async () => {
    await expect(isTokenRevoked("jti-trigger-backoff")).rejects.toBeInstanceOf(RevocationStatusUnavailableError);
    expect(tokenRevocationBackoffForTests().downUntil).toBeGreaterThan(Date.now());
    // Even inside the read backoff window the write is attempted and reported as not durable.
    expect(await revokeToken("jti-queued-1", Date.now() + 60_000)).toBe(false);
    expect(await revokeToken("jti-queued-2", Date.now() + 60_000)).toBe(false);
    expect(tokenRevocationBackoffForTests().pendingWrites).toBe(2);
  });

  it("logout fails loudly when the revocation could not be stored, so the UI notice appears", async () => {
    const jwt = { signAsync: async () => "signed", verifyAsync: async () => ({ sub: "u1", jti: "jti-logout", exp: Math.floor(Date.now() / 1000) + 600 }) };
    const auth = new AuthService({ user: { findUnique: async () => null } } as never, jwt as never);
    await expect(auth.logout("token")).rejects.toThrow(/could not be stored/);
    // This process still treats the token as revoked.
    expect(await isTokenRevoked("jti-logout")).toBe(true);
  });
});
