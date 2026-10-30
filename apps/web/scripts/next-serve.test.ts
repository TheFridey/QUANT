import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs launcher without type declarations
import { nextServeArgs } from "./next-serve.mjs";

describe("web listen address (audit M4)", () => {
  it("binds loopback by default", () => {
    expect(nextServeArgs("start", {})).toEqual(["start", "--hostname", "127.0.0.1", "--port", "4317"]);
    expect(nextServeArgs("dev", {})).toEqual(["dev", "--hostname", "127.0.0.1", "--port", "4317"]);
  });

  it("widens only when WEB_HOST is set", () => {
    expect(nextServeArgs("start", { WEB_HOST: "0.0.0.0" })).toEqual(["start", "--hostname", "0.0.0.0", "--port", "4317"]);
  });
});
