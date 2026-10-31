#!/usr/bin/env node
// Read-only report (audit H1 / B4): lists stored strategy configs that fail validation now that
// parseStrategyConfig no longer heals legacy values on load. It never writes or rewrites anything;
// the operator fixes each config deliberately.
//
// Usage: pnpm build:packages && node scripts/report-invalid-configs.mjs
// Reads DATABASE_URL from the environment. Exit code 1 when any config is invalid.
import process from "node:process";
import { parseStrategyConfig } from "../packages/shared/dist/index.js";
import { createPrismaClient } from "../packages/shared/dist/db.js";

function check(source, id, config) {
  try {
    parseStrategyConfig(config);
    return null;
  } catch (error) {
    const issues = Array.isArray(error?.issues) ? error.issues : [{ path: [], message: String(error?.message ?? error) }];
    return {
      source,
      id,
      fields: issues.map((issue) => ({ field: issue.path.map(String).join(".") || "(root)", message: issue.message })),
    };
  }
}

const prisma = createPrismaClient();
try {
  const findings = [];
  for (const row of await prisma.engineControl.findMany({ select: { id: true, config: true } })) {
    const finding = check("EngineControl", row.id, row.config);
    if (finding) findings.push(finding);
  }
  for (const row of await prisma.strategyVersion.findMany({ select: { id: true, config: true } })) {
    const finding = check("StrategyVersion", row.id, row.config);
    if (finding) findings.push(finding);
  }
  for (const row of await prisma.strategyPromotion.findMany({ select: { id: true, config: true } })) {
    const finding = check("StrategyPromotion", row.id, row.config);
    if (finding) findings.push(finding);
  }
  if (findings.length === 0) {
    process.stdout.write("All stored strategy configs pass validation.\n");
  } else {
    for (const finding of findings) {
      process.stdout.write(`${finding.source} ${finding.id}\n`);
      for (const field of finding.fields) process.stdout.write(`  - ${field.field}: ${field.message}\n`);
    }
    process.stdout.write(`${findings.length} invalid config(s). Nothing was changed.\n`);
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}
