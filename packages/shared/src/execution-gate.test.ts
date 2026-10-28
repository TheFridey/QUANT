import { describe, expect, it } from "vitest";
import { assertPaperOrSandboxOnly, resolveExecutionMode } from "./execution-gate.js";

describe("live money execution gate", () => {
  it("defaults to PAPER and allows paper/sandbox", () => {
    expect(resolveExecutionMode({})).toBe("PAPER");
    expect(assertPaperOrSandboxOnly({ EXECUTION_MODE: "PAPER" }).ok).toBe(true);
    expect(assertPaperOrSandboxOnly({ EXECUTION_MODE: "SANDBOX" }).ok).toBe(true);
  });

  it("refuses LIVE even when flags are set because no broker adapter exists", () => {
    const refused = assertPaperOrSandboxOnly({
      EXECUTION_MODE: "LIVE",
      LIVE_MONEY_ENABLED: "true",
      LIVE_MONEY_CONFIRM: "I_UNDERSTAND_LIVE_RISK",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/no live broker/i);
  });

  it("refuses LIVE without confirm flags", () => {
    const refused = assertPaperOrSandboxOnly({ EXECUTION_MODE: "LIVE" });
    expect(refused.ok).toBe(false);
  });
});
