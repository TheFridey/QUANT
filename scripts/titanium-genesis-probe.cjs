// Disposable-only diagnostic. Run after pnpm build:packages, from repository root.
// Does not load .env, compute research, consume holdouts or touch account state.
const { resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { PrismaClient } = require(resolve('packages/shared/dist/db.js'));
const { registerModel } = require(resolve('packages/evolution/dist/genesis/model-registry.js'));
const { fixtureArtefact, fixtureRegistration } = require(resolve('packages/evolution/dist/genesis/test-fixtures.js'));

async function main() {
  const url = new URL(process.env.DATABASE_URL_TEST || 'invalid:');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
    || url.port !== '55432' || url.pathname !== '/odin_test_titanium_regression'
    || url.search) throw new Error('EXPLICIT_TITANIUM_DISPOSABLE_TARGET_REQUIRED');
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [{ level: 'query', emit: 'event' }] });
  let queries = [];
  db.$on('query', (event) => queries.push({ operation: event.query.trim().split(/\s+/)[0], durationMs: event.duration }));
  try {
    const [identity] = await db.$queryRawUnsafe('SELECT current_database() AS name');
    if (identity.name !== 'odin_test_titanium_regression') throw new Error('DATABASE_IDENTITY_MISMATCH');
    const rows = [];
    const family = `titanium-probe-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
      queries = [];
      const start = performance.now();
      const result = await registerModel(db, fixtureRegistration({ family, version: String(i), artefact: fixtureArtefact({ trainedThroughTime: Date.now() - 86400000 }) }));
      rows.push({ status: result.status, wallMs: Math.round(performance.now() - start), queries: [...queries] });
    }
    const plan = await db.$queryRawUnsafe('EXPLAIN SELECT id FROM "ModelVersion" WHERE family=$1 AND version=$2', family, '0');
    const waits = await db.$queryRawUnsafe('SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted');
    console.log(JSON.stringify({ target: 'local disposable PostgreSQL 16; unchanged Prisma timeout', rows, plan, waits }, null, 2));
  } finally { await db.$disconnect(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
