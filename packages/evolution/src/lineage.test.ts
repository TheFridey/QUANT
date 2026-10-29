import { describe, expect, it } from "vitest";
import {
  appendLineageNode,
  approvalStillValid,
  buildDistinctHashes,
  evaluationPartitions,
  findRollbackTarget,
  type LineageChain,
} from "./lineage.js";

describe("§13 / D28 research lineage", () => {
  it("keeps distinct hashes for source/executable/config/dataset/report/protocol/deps", () => {
    const hashes = buildDistinctHashes({
      source: { code: "a" },
      executable: { bytecode: "b" },
      config: { stop: 2 },
      dataset: { id: "ds1" },
      report: { n: 10 },
      protocol: { v: 1 },
      deps: { pkg: "x@1" },
    });
    const values = Object.values(hashes);
    expect(new Set(values).size).toBe(values.length);
  });

  it("does not copy aggregate into untouched-test fields when unmeasured", () => {
    const part = evaluationPartitions({
      aggregateReturnPct: "12.5",
      measuredUntouched: false,
    });
    expect(part.aggregateReturnPct).toBe("12.5");
    expect(part.untouchedTestReturnPct).toBeNull();
    expect(part.unknown).toBe(true);
  });

  it("invalidates approval when config hash changes", () => {
    const approved = buildDistinctHashes({
      source: 1,
      executable: 1,
      config: { a: 1 },
      dataset: 1,
      report: 1,
      protocol: 1,
      deps: 1,
    });
    const current = buildDistinctHashes({
      source: 1,
      executable: 1,
      config: { a: 2 },
      dataset: 1,
      report: 1,
      protocol: 1,
      deps: 1,
    });
    expect(
      approvalStillValid({
        approvedHashes: approved,
        currentHashes: current,
      }),
    ).toBe(false);
  });

  it("supports hypothesis→…→promotion→rollback chain", () => {
    let chain: LineageChain = { nodes: [] };
    const hashes = buildDistinctHashes({
      source: "s",
      executable: "e",
      config: "c",
      dataset: "d",
      report: "r",
      protocol: "p",
      deps: "dep",
    });
    chain = appendLineageNode(chain, {
      id: "h1",
      kind: "HYPOTHESIS",
      at: "t0",
      hashes: { sourceHash: hashes.sourceHash },
      parentId: null,
      evaluation: evaluationPartitions({ aggregateReturnPct: null, measuredUntouched: false }),
    });
    chain = appendLineageNode(chain, {
      id: "promo1",
      kind: "PROMOTION",
      at: "t1",
      hashes,
      parentId: "h1",
      evaluation: evaluationPartitions({
        aggregateReturnPct: "1",
        measuredUntouched: true,
        untouchedTestReturnPct: "0.5",
        untouchedSampleSize: 20,
      }),
    });
    expect(findRollbackTarget(chain, "promo1")?.id).toBe("h1");
  });
});
