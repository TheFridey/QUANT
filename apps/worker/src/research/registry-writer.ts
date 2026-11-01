import type { ValidationConfig, ValidationReport } from "@odin/backtest";
import { Prisma, type PrismaClient } from "@odin/shared/db";

/** Append-only registry writes shared by the ASCEND research CLIs. One transaction per run. */

export function summary(r: ValidationReport, costBasis: string) {
  return {
    costBasis,
    trialCount: r.trialCount,
    selectedParamsByFold: r.selectedParamsByFold,
    gridScale: r.gridScale,
    oos: r.oos && {
      bars: r.oos.bars, trades: r.oos.trades, totalReturn: r.oos.totalReturn, sharpe: r.oos.sharpe, sortino: r.oos.sortino, maxDrawdown: r.oos.maxDrawdown,
      winRate: r.oos.winRate, profitFactor: r.oos.profitFactor, expectancy: r.oos.expectancy, exposure: r.oos.exposure, turnover: r.oos.turnover,
    },
    oosGross: r.oosGross,
    oosControls: r.oosControls,
    psr: r.psr,
    dsr: r.dsr,
    dsrProgramme: r.dsrProgramme,
    costSensitivity: r.costSensitivity,
    pbo: r.pbo,
    holdout: r.holdout && { params: r.holdout.params, totalReturn: r.holdout.stats.totalReturn, sharpe: r.holdout.stats.sharpe, trades: r.holdout.stats.trades },
  };
}

export async function recordValidation(
  prisma: PrismaClient,
  input: { datasetId: string; codeVersion: string; config: ValidationConfig; report: ValidationReport; costBasis: string },
): Promise<void> {
  const { datasetId, codeVersion, config, report } = input;
  await prisma.$transaction(async (tx) => {
    const run = await tx.researchRun.create({
      data: {
        datasetId,
        datasetVersion: report.datasetVersion,
        codeVersion,
        strategyId: report.strategyId,
        strategyVersion: report.strategyVersion,
        family: report.family,
        config: config as unknown as Prisma.InputJsonValue,
        verdict: report.verdict,
        reasons: report.reasons,
        evidence: report.evidence,
        summary: summary(report, input.costBasis) as unknown as Prisma.InputJsonValue,
      },
    });
    if (report.trials.length) {
      await tx.researchTrial.createMany({
        data: report.trials.map((t) => ({
          runId: run.id,
          window: t.window,
          fold: t.fold,
          params: t.params,
          startT: new Date(t.startT),
          endT: new Date(t.endT),
          bars: t.bars,
          trades: t.trades,
          netReturn: t.netReturn,
          sharpe: t.sharpe,
          perBarSharpe: t.perBarSharpe,
        })),
      });
    }
    // The unique key makes a second holdout evaluation fail the whole transaction.
    if (report.trials.some((t) => t.window === "HOLDOUT")) {
      await tx.researchHoldoutAccess.create({ data: { strategyId: report.strategyId, strategyVersion: report.strategyVersion, datasetId, runId: run.id } });
    }
  });
}
