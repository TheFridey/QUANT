import { describe, expect, it } from "vitest";
import { stageJobId } from "./ids.js";

describe("stageJobId", () => {
  it("keeps BullMQ custom ids free of colons", () => {
    const id = stageJobId("sentinel", "cyc_63337890-0064-4583-a735-8a1ea1d85c53");
    expect(id).toBe("sentinel-cyc_63337890-0064-4583-a735-8a1ea1d85c53");
    expect(id.includes(":")).toBe(false);
    expect(id.split(":").length).toBe(1);
  });

  it("rejects stages that would not survive a queue id", () => {
    expect(() => stageJobId("in:gest", "cyc_63337890-0064-4583-a735-8a1ea1d85c53")).toThrow(/Invalid stage job id/);
  });
});
