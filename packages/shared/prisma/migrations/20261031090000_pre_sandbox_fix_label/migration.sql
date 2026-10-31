-- Audit C1/C2 (30 Oct 2026): results produced before the streaming fd-3 sandbox could have
-- seen future bars or carried forged signals. Existing rows take PRE_SANDBOX_FIX from the
-- column default (ADD COLUMN does not fire the evidence-immutability row triggers); new
-- rows default to STREAMING_FD3. Promotion must refuse PRE_SANDBOX_FIX evidence.
ALTER TABLE "ExperimentReport" ADD COLUMN "sandboxEra" TEXT NOT NULL DEFAULT 'PRE_SANDBOX_FIX';
ALTER TABLE "ExperimentReport" ALTER COLUMN "sandboxEra" SET DEFAULT 'STREAMING_FD3';

ALTER TABLE "BacktestRun" ADD COLUMN "sandboxEra" TEXT NOT NULL DEFAULT 'PRE_SANDBOX_FIX';
ALTER TABLE "BacktestRun" ALTER COLUMN "sandboxEra" SET DEFAULT 'STREAMING_FD3';

ALTER TABLE "StrategyArtifact" ADD COLUMN "sandboxEra" TEXT NOT NULL DEFAULT 'PRE_SANDBOX_FIX';
ALTER TABLE "StrategyArtifact" ALTER COLUMN "sandboxEra" SET DEFAULT 'STREAMING_FD3';
