-- ASCEND-00 F6: append-only history of engine configuration. Production losses on 31 Oct could not be
-- tied to the config in force because only the current config was stored. A trigger on EngineControl
-- records every insert and every config change, whichever code path (API PATCH, promotion, bootstrap,
-- raw SQL) made it. Rows are never updated or deleted.
CREATE TABLE "EngineConfigRevision" (
    "id" BIGSERIAL NOT NULL,
    "engineId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "previousConfig" JSONB,
    "changedKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "configHash" TEXT NOT NULL,
    "actor" TEXT,
    "engineUpdatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngineConfigRevision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EngineConfigRevision_engineId_engineUpdatedAt_idx" ON "EngineConfigRevision"("engineId", "engineUpdatedAt");

CREATE TRIGGER "EngineConfigRevision_append_only"
  BEFORE UPDATE OR DELETE ON "EngineConfigRevision"
  FOR EACH ROW EXECUTE FUNCTION odin_reject_evidence_mutation();

CREATE OR REPLACE FUNCTION odin_record_engine_config_revision() RETURNS trigger AS $$
DECLARE
  changed TEXT[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."config" IS NOT DISTINCT FROM NEW."config" THEN
      RETURN NEW;
    END IF;
    SELECT COALESCE(array_agg(k ORDER BY k), ARRAY[]::TEXT[]) INTO changed
    FROM (
      SELECT jsonb_object_keys(COALESCE(NEW."config", '{}'::jsonb)) AS k
      UNION
      SELECT jsonb_object_keys(COALESCE(OLD."config", '{}'::jsonb))
    ) keys
    WHERE OLD."config" -> k IS DISTINCT FROM NEW."config" -> k;
  END IF;
  INSERT INTO "EngineConfigRevision"
    ("engineId", "source", "config", "previousConfig", "changedKeys", "configHash", "actor", "engineUpdatedAt")
  VALUES (
    NEW."id",
    TG_OP,
    NEW."config",
    CASE WHEN TG_OP = 'UPDATE' THEN OLD."config" ELSE NULL END,
    COALESCE(changed, ARRAY[]::TEXT[]),
    md5(NEW."config"::text),
    NEW."updatedBy",
    NEW."updatedAt"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EngineControl_config_revision"
  AFTER INSERT OR UPDATE OF "config" ON "EngineControl"
  FOR EACH ROW EXECUTE FUNCTION odin_record_engine_config_revision();

-- Baseline: the config in force when history starts. Earlier history is not recoverable.
INSERT INTO "EngineConfigRevision"
  ("engineId", "source", "config", "previousConfig", "changedKeys", "configHash", "actor", "engineUpdatedAt")
SELECT "id", 'BASELINE', "config", NULL, ARRAY[]::TEXT[], md5("config"::text), "updatedBy", "updatedAt"
FROM "EngineControl";
