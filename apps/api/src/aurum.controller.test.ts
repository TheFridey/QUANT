import { afterEach, describe, expect, it } from "vitest";
import { AurumController } from "./aurum.controller.js";

describe("AURUM readiness: legacy crypto mode (CATALYST)", () => {
  const previous = process.env.LEGACY_CRYPTO_MODE;
  afterEach(() => {
    if (previous === undefined) delete process.env.LEGACY_CRYPTO_MODE;
    else process.env.LEGACY_CRYPTO_MODE = previous;
  });

  it("reports RETIRED, with its source, when the API environment retires legacy crypto", () => {
    process.env.LEGACY_CRYPTO_MODE = "RETIRED";
    expect(new AurumController().readiness().legacyCrypto).toEqual({
      mode: "RETIRED",
      discoveryEnabled: false,
      newEntriesEnabled: false,
      issue: null,
      source: "API_PROCESS_ENV",
    });
  });

  it("reports ACTIVE by default and surfaces a mistyped value", () => {
    delete process.env.LEGACY_CRYPTO_MODE;
    expect(new AurumController().readiness().legacyCrypto).toMatchObject({ mode: "ACTIVE", newEntriesEnabled: true });
    process.env.LEGACY_CRYPTO_MODE = "RETIERD";
    expect(new AurumController().readiness().legacyCrypto).toMatchObject({ mode: "RETIRED", issue: "UNRECOGNISED_LEGACY_CRYPTO_MODE:RETIERD" });
  });

  it("keeps the inactive readiness contract unchanged", () => {
    const r = new AurumController().readiness() as Record<string, unknown>;
    expect(Object.keys(r)).toContain("legacyCrypto");
    expect(Object.keys(r).length).toBeGreaterThan(1);
  });
});
