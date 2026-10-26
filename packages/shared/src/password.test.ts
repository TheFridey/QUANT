import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password", () => {
  it("verifies a scrypt hash and rejects a wrong password", async () => {
    const hash = await hashPassword("odin-paper-dev");
    expect(await verifyPassword("odin-paper-dev", hash)).toBe(true);
    expect(await verifyPassword("not-the-password", hash)).toBe(false);
    expect(await verifyPassword("odin-paper-dev", "nope")).toBe(false);
  });
});
