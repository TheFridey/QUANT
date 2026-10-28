import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORACLE_LIMITS,
  FileOracleQueue,
  ORACLE_CAPABILITIES,
  admitOracleItem,
  emptyOracleQueue,
  labelAsAiDiscovery,
  noteOracleFailure,
  proposeOracleCycle,
  type OracleQueueRecord,
} from "./oracle-research.js";

function item(partial: Partial<OracleQueueRecord> = {}): Omit<OracleQueueRecord, "status" | "fingerprint" | "aiDiscovery" | "failureStreak"> {
  return {
    id: partial.id ?? "rq-1",
    capability: partial.capability ?? "RECOMMEND_EXPERIMENT",
    priority: partial.priority ?? 40,
    hypothesisId: partial.hypothesisId ?? "hyp-1",
    strategyId: partial.strategyId ?? null,
    reason: partial.reason ?? "measure untouched window",
    createdAt: "2026-10-28T17:00:00.000Z",
    budgetUsd: partial.budgetUsd ?? "0.1000",
    retries: partial.retries ?? 0,
    provenance: partial.provenance ?? "DETERMINISTIC_SUPERVISOR",
    modelIdentifier: partial.modelIdentifier ?? null,
  };
}

describe("oracle bounded research", () => {
  it("proposes the thirteen capabilities without storing a template as a discovery", () => {
    expect(ORACLE_CAPABILITIES).toHaveLength(13);
    const proposals = proposeOracleCycle({
      performance: { returnPct: null, sampleSize: 0, maxDrawdownPct: null },
      memory: [
        {
          tradeId: "t1",
          pairAddress: "pair",
          phase: "BEFORE",
          capturedAt: "2026-10-28T17:00:00.000Z",
          context: { condition: "m5-thrust" },
          postExit: false,
        },
        {
          tradeId: "t1",
          pairAddress: "pair",
          phase: "AFTER",
          capturedAt: "2026-10-28T17:05:00.000Z",
          context: { condition: "m5-thrust", realizedPnlUsd: "10" },
          postExit: true,
        },
      ],
      challengePassed: false,
      challengeFindings: ["SAMPLE_SIZE"],
      baselines: [],
      hypothesisId: "hyp-1",
      openConditions: ["m5 thrust continues"],
    });
    expect(proposals.map((row) => row.capability)).toEqual([...ORACLE_CAPABILITIES]);
    expect(proposals.every((row) => row.aiDiscovery === false && row.provenance === "DETERMINISTIC_SUPERVISOR")).toBe(true);
    expect(proposals.find((row) => row.capability === "REVIEW_PERFORMANCE")?.returnPct).toBeNull();
    expect(proposals.find((row) => row.capability === "EXAMINE_TRADE_MEMORY")?.reason).toContain("Entry-safe memory rows 1");
    expect(labelAsAiDiscovery({ provenance: "MODEL", modelIdentifier: "MOCK" })).toBe(false);
    expect(labelAsAiDiscovery({ provenance: "MODEL", modelIdentifier: "TEMPLATE" })).toBe(false);
    expect(labelAsAiDiscovery({ provenance: "DETERMINISTIC_SUPERVISOR", modelIdentifier: null })).toBe(false);
  });

  it("enforces spend, concurrency, retry, dedup, and repeated-failure limits and persists them", () => {
    const limits = { ...DEFAULT_ORACLE_LIMITS, maxConcurrent: 1, maxSpendUsdPerDay: "0.2500", maxRetries: 1, maxRepeatedFailures: 2 };
    let snapshot = emptyOracleQueue();
    const first = admitOracleItem(snapshot, item(), limits);
    expect(first.accepted).toBe(true);
    snapshot = first.snapshot;
    const duplicate = admitOracleItem(snapshot, item({ id: "rq-2" }), limits);
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.reason).toBe("duplicate hypothesis work");
    const concurrent = admitOracleItem(
      snapshot,
      item({ id: "rq-3", capability: "REVIEW_PERFORMANCE", reason: "other work" }),
      limits,
    );
    expect(concurrent.reason).toBe("max concurrent research items");
    snapshot = { ...snapshot, items: snapshot.items.map((row) => ({ ...row, status: "DONE" })) };
    const spend = admitOracleItem(
      snapshot,
      item({ id: "rq-4", capability: "WEAKNESSES", reason: "cost check", budgetUsd: "1.0000" }),
      limits,
    );
    expect(spend.reason).toBe("daily spend cap");
    const retry = admitOracleItem(emptyOracleQueue(), item({ retries: 3 }), limits);
    expect(retry.reason).toBe("max retries");
    const impersonation = admitOracleItem(
      emptyOracleQueue(),
      { ...item({ provenance: "MODEL", modelIdentifier: "MOCK" }), aiDiscovery: true },
      limits,
    );
    expect(impersonation.accepted).toBe(false);
    expect(first.record?.aiDiscovery).toBe(false);

    let failing = emptyOracleQueue();
    failing = noteOracleFailure(failing, limits);
    failing = noteOracleFailure(failing, limits);
    expect(failing.terminated).toBe(true);
    const blocked = admitOracleItem(failing, item({ id: "rq-5", reason: "after failures" }), limits);
    expect(blocked.accepted).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "odin-oracle-"));
    const store = new FileOracleQueue(join(dir, "queue.json"));
    store.write(first.snapshot);
    const reloaded = new FileOracleQueue(join(dir, "queue.json")).read();
    expect(reloaded.items).toHaveLength(1);
    expect(reloaded.spentUsd).toBe(first.snapshot.spentUsd);
    expect(JSON.stringify(reloaded)).not.toContain("API_KEY");
  });
});
