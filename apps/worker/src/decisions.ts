import type { DecisionDraft } from "@odin/agent-core";
import { toJson, type Prisma, type PrismaClient } from "@odin/shared/db";

/** One AgentDecision row per (cycle, agent, pair); a retry overwrites the row it wrote before. */
export async function upsertDecision(
  db: PrismaClient | Prisma.TransactionClient,
  cycleId: string,
  decision: DecisionDraft,
): Promise<void> {
  await db.agentDecision.upsert({
    where: {
      cycleId_agent_pairAddress: { cycleId, agent: decision.agent, pairAddress: decision.pairAddress },
    },
    create: {
      cycleId,
      agent: decision.agent,
      modelVersion: decision.modelVersion,
      pairAddress: decision.pairAddress,
      decision: decision.decision,
      confidence: decision.confidence,
      reasonCodes: decision.reasonCodes,
      input: toJson(decision.input),
      output: toJson(decision.output),
      inputSource: decision.inputSource ?? null,
      durationMs: decision.durationMs ?? null,
    },
    update: {
      modelVersion: decision.modelVersion,
      decision: decision.decision,
      confidence: decision.confidence,
      reasonCodes: decision.reasonCodes,
      input: toJson(decision.input),
      output: toJson(decision.output),
      inputSource: decision.inputSource ?? null,
      durationMs: decision.durationMs ?? null,
      // ASCEND-09: an overwrite keeps createdAt, so point-in-time views rely on this (a DB trigger also bumps it).
      updatedAt: new Date(),
    },
  });
}
