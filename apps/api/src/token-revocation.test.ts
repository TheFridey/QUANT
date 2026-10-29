import { describe, expect, it, beforeEach } from "vitest";
import {
  isTokenRevoked,
  resetTokenRevocationForTests,
  revokeToken,
  tokenFingerprint,
} from "./token-revocation.js";
import { allowedWebOrigins, isAllowedSocketOrigin } from "./socket-origins.js";

describe("token revocation store", () => {
  beforeEach(() => {
    resetTokenRevocationForTests();
  });

  it("revokes by id until expiry", async () => {
    const id = "jti-test-1";
    expect(await isTokenRevoked(id)).toBe(false);
    await revokeToken(id, Date.now() + 60_000);
    expect(await isTokenRevoked(id)).toBe(true);
  });

  it("fingerprints opaque tokens stably", () => {
    expect(tokenFingerprint("abc")).toBe(tokenFingerprint("abc"));
    expect(tokenFingerprint("abc")).not.toBe(tokenFingerprint("abd"));
  });
});

describe("socket origins", () => {
  it("includes WEB_ORIGIN and local paper defaults", () => {
    const origins = allowedWebOrigins("https://quant.example");
    expect(origins).toContain("https://quant.example");
    expect(origins).toContain("http://127.0.0.1:4317");
    expect(origins).toContain("http://localhost:4317");
  });

  it("rejects foreign browser origins", () => {
    const allowed = allowedWebOrigins("http://127.0.0.1:4317");
    expect(isAllowedSocketOrigin("https://evil.example", allowed)).toBe(false);
    expect(isAllowedSocketOrigin("http://127.0.0.1:4317", allowed)).toBe(true);
    expect(isAllowedSocketOrigin(undefined, allowed)).toBe(true);
  });
});
