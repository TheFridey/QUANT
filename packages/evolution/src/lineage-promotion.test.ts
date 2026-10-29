import { describe, expect, it } from "vitest";
import {
  appendLineageNode,
  buildDistinctHashes,
  evaluationPartitions,
  validateLineageForPromotion,
  type LineageChain,
} from "./lineage.js";

describe("validateLineageForPromotion (§19–§20)", () => {
  it("refuses report-hash-as-executable and requires approval binding", () => {
    const hashes = buildDistinctHashes({
      source: { a: 1 },
      executable: { b: 2 },
      config: { c: 3 },
      dataset: { d: 4 },
      report: { e: 5 },
      protocol: { f: 6 },
      deps: { g: 7 },
    });
    let chain: LineageChain = { nodes: [] };
    chain = appendLineageNode(chain, {
      id: "hyp1",
      kind: "HYPOTHESIS",
      at: new Date().toISOString(),
      parentId: null,
      hashes: {},
      evaluation: evaluationPartitions({ aggregateReturnPct: null, measuredUntouched: false }),
    });
    chain = appendLineageNode(chain, {
      id: "ds1",
      kind: "DATASET",
      at: new Date().toISOString(),
      parentId: "hyp1",
      hashes: { datasetHash: hashes.datasetHash },
      evaluation: evaluationPartitions({ aggregateReturnPct: null, measuredUntouched: false }),
    });
    chain = appendLineageNode(chain, {
      id: "exp1",
      kind: "EXPERIMENT",
      at: new Date().toISOString(),
      parentId: "ds1",
      hashes,
      evaluation: evaluationPartitions({ aggregateReturnPct: null, measuredUntouched: false }),
    });
    chain = appendLineageNode(chain, {
      id: "rpt1",
      kind: "REPORT",
      at: new Date().toISOString(),
      parentId: "exp1",
      hashes: { ...hashes, executableHash: hashes.reportHash },
      evaluation: evaluationPartitions({
        aggregateReturnPct: "1",
        measuredUntouched: false,
      }),
    });
    const bad = validateLineageForPromotion({
      chain,
      reportId: "rpt1",
      sourceHash: hashes.sourceHash,
      artifactHash: hashes.executableHash,
      configHash: hashes.configHash,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/report-hash-as-executable|APPROVAL|executable/i);
  });

  it("accepts distinct hashes with matching approval", () => {
    const hashes = buildDistinctHashes({
      source: "src",
      executable: "exe",
      config: "cfg",
      dataset: "ds",
      report: "rpt",
      protocol: "proto",
      deps: "deps",
    });
    let chain: LineageChain = { nodes: [] };
    chain = appendLineageNode(chain, {
      id: "hyp1",
      kind: "HYPOTHESIS",
      at: new Date().toISOString(),
      parentId: null,
      hashes: {},
      evaluation: evaluationPartitions({ aggregateReturnPct: null, measuredUntouched: false }),
      meta: { persisted: true },
    });
    chain = appendLineageNode(chain, {
      id: "ds1",
      kind: "DATASET",
      at: new Date().toISOString(),
      parentId: "hyp1",
      hashes: { datasetHash: hashes.datasetHash },
      evaluation: evaluationPartitions({ aggregateReturnPct: null, measuredUntouched: false }),
    });
    chain = appendLineageNode(chain, {
      id: "exp1",
      kind: "EXPERIMENT",
      at: new Date().toISOString(),
      parentId: "ds1",
      hashes,
      evaluation: evaluationPartitions({ aggregateReturnPct: null, measuredUntouched: false }),
    });
    chain = appendLineageNode(chain, {
      id: "rpt1",
      kind: "REPORT",
      at: new Date().toISOString(),
      parentId: "exp1",
      hashes: { ...hashes, reportHash: hashes.reportHash, datasetHash: hashes.datasetHash },
      evaluation: evaluationPartitions({
        aggregateReturnPct: "1.2",
        measuredUntouched: true,
        untouchedTestReturnPct: "0.8",
        untouchedSampleSize: 30,
      }),
    });
    chain = appendLineageNode(chain, {
      id: "appr1",
      kind: "APPROVAL",
      at: new Date().toISOString(),
      parentId: "rpt1",
      hashes: {
        sourceHash: hashes.sourceHash,
        executableHash: hashes.executableHash,
        configHash: hashes.configHash,
        reportHash: hashes.reportHash,
      },
      evaluation: evaluationPartitions({
        aggregateReturnPct: "1.2",
        measuredUntouched: true,
        untouchedTestReturnPct: "0.8",
        untouchedSampleSize: 30,
      }),
      meta: { decision: "APPROVED", reviewer: "operator@odin.local" },
    });
    const ok = validateLineageForPromotion({
      chain,
      reportId: "rpt1",
      sourceHash: hashes.sourceHash,
      artifactHash: hashes.executableHash,
      configHash: hashes.configHash,
      approvalId: "appr1",
    });
    expect(ok).toEqual({ ok: true });
  });
});
