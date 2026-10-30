import { describe, expect, it } from "vitest";
import { assertDeploymentSecrets, isLoopbackOrigin } from "./bootstrap.js";

const strong = "x".repeat(24) + "-strong-random-secret-value";
const shared = "https://odin.example.com";

describe("deployment secret checks (audit M7)", () => {
  it("recognises loopback origins", () => {
    expect(isLoopbackOrigin("http://127.0.0.1:4317")).toBe(true);
    expect(isLoopbackOrigin("http://localhost:4317")).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:4317")).toBe(true);
    expect(isLoopbackOrigin("http://127.10.0.5")).toBe(true);
    expect(isLoopbackOrigin("http://192.168.1.10:4317")).toBe(false);
    expect(isLoopbackOrigin("https://odin.example.com")).toBe(false);
    expect(isLoopbackOrigin("not a url")).toBe(false);
  });

  it("allows the published samples on loopback only (local dev and CI)", () => {
    expect(() =>
      assertDeploymentSecrets({ jwtSecret: "ci-jwt-secret-not-for-production", adminPassword: "odin-paper-dev", webOrigin: "http://127.0.0.1:4317" }),
    ).not.toThrow();
  });

  it("refuses a JWT secret shorter than 32 characters off loopback", () => {
    expect(() => assertDeploymentSecrets({ jwtSecret: "short-but-not-sample-16", adminPassword: "a-real-password", webOrigin: shared })).toThrow(
      /at least 32 characters/,
    );
  });

  it("refuses each published JWT sample off loopback, whatever its length", () => {
    for (const jwtSecret of [
      "replace-with-a-long-random-string-padded-out-to-length",
      "ci-jwt-secret-not-for-production",
      "local-development-secret-that-is-long-enough-123",
    ]) {
      expect(() => assertDeploymentSecrets({ jwtSecret, adminPassword: "a-real-password", webOrigin: shared })).toThrow(/sample value/);
    }
  });

  it("refuses the sample admin password off loopback", () => {
    expect(() => assertDeploymentSecrets({ jwtSecret: strong, adminPassword: "odin-paper-dev", webOrigin: shared })).toThrow(/ADMIN_PASSWORD/);
  });

  it("refuses regardless of NODE_ENV", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      expect(() => assertDeploymentSecrets({ jwtSecret: strong, adminPassword: "odin-paper-dev", webOrigin: "http://10.0.0.5:4317" })).toThrow();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("accepts strong, non-sample secrets off loopback", () => {
    expect(() => assertDeploymentSecrets({ jwtSecret: strong, adminPassword: "a-real-password", webOrigin: shared })).not.toThrow();
  });
});

describe("API listen address (audit M4)", () => {
  const base = {
    DATABASE_URL: "postgresql://x",
    REDIS_URL: "redis://x",
    JWT_SECRET: "ci-jwt-secret-not-for-production",
    ADMIN_EMAIL: "admin@odin.local",
    ADMIN_PASSWORD: "odin-paper-dev",
    WEB_ORIGIN: "http://127.0.0.1:4317",
  };

  async function withEnv(extra: Record<string, string>) {
    const saved = { ...process.env };
    for (const key of ["API_HOST", "API_PORT", "NODE_ENV"]) delete process.env[key];
    Object.assign(process.env, base, extra);
    try {
      const { loadEnvConfig } = await import("./bootstrap.js");
      return await loadEnvConfig();
    } finally {
      process.env = saved;
    }
  }

  it("binds loopback by default", async () => {
    expect((await withEnv({})).apiHost).toBe("127.0.0.1");
  });

  it("binds a wider address only when API_HOST says so", async () => {
    expect((await withEnv({ API_HOST: "0.0.0.0" })).apiHost).toBe("0.0.0.0");
  });
});
