-- CreateTable
CREATE TABLE "HistoricalDataset" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "instrumentKey" TEXT NOT NULL,
    "instrumentKind" TEXT NOT NULL,
    "cohort" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "licence" JSONB NOT NULL,
    "versionHash" TEXT,
    "barCount" INTEGER NOT NULL DEFAULT 0,
    "firstOpenTime" TIMESTAMP(3),
    "lastOpenTime" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoricalDataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalBar" (
    "datasetId" TEXT NOT NULL,
    "openTime" TIMESTAMP(3) NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(38,18) NOT NULL,
    "high" DECIMAL(38,18) NOT NULL,
    "low" DECIMAL(38,18) NOT NULL,
    "close" DECIMAL(38,18) NOT NULL,
    "volume" DECIMAL(38,8),
    "extra" JSONB,
    "hash" TEXT NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoricalBar_pkey" PRIMARY KEY ("datasetId","openTime")
);

-- CreateTable
CREATE TABLE "HistoricalBarRevision" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "openTime" TIMESTAMP(3) NOT NULL,
    "previousHash" TEXT NOT NULL,
    "newHash" TEXT NOT NULL,
    "newValues" JSONB NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HistoricalBarRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalBarRejection" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "openTime" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HistoricalBarRejection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalRawBatch" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "request" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "payload" JSONB,

    CONSTRAINT "HistoricalRawBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalBackfillJob" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "cursor" TEXT,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "rowsImported" INTEGER NOT NULL DEFAULT 0,
    "rowsRejected" INTEGER NOT NULL DEFAULT 0,
    "revisionsDetected" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoricalBackfillJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HistoricalDataset_cohort_idx" ON "HistoricalDataset"("cohort");

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalDataset_sourceId_instrumentKey_interval_key" ON "HistoricalDataset"("sourceId", "instrumentKey", "interval");

-- CreateIndex
CREATE INDEX "HistoricalBar_datasetId_availableAt_idx" ON "HistoricalBar"("datasetId", "availableAt");

-- CreateIndex
CREATE INDEX "HistoricalBarRevision_datasetId_openTime_idx" ON "HistoricalBarRevision"("datasetId", "openTime");

-- CreateIndex
CREATE INDEX "HistoricalBarRejection_datasetId_reason_idx" ON "HistoricalBarRejection"("datasetId", "reason");

-- CreateIndex
CREATE INDEX "HistoricalRawBatch_jobId_fetchedAt_idx" ON "HistoricalRawBatch"("jobId", "fetchedAt");

-- CreateIndex
CREATE INDEX "HistoricalBackfillJob_status_idx" ON "HistoricalBackfillJob"("status");

-- AddForeignKey
ALTER TABLE "HistoricalBar" ADD CONSTRAINT "HistoricalBar_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "HistoricalDataset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalBackfillJob" ADD CONSTRAINT "HistoricalBackfillJob_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "HistoricalDataset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ASCEND-01: stored bars and raw provider batches are immutable evidence. A provider revision is
-- recorded in "HistoricalBarRevision"; the original row is never rewritten or deleted.
CREATE FUNCTION odin_historical_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (ASCEND-01)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "HistoricalBar_immutable"
  BEFORE UPDATE OR DELETE ON "HistoricalBar"
  FOR EACH ROW EXECUTE FUNCTION odin_historical_immutable();

CREATE TRIGGER "HistoricalRawBatch_immutable"
  BEFORE UPDATE OR DELETE ON "HistoricalRawBatch"
  FOR EACH ROW EXECUTE FUNCTION odin_historical_immutable();
