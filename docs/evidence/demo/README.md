# Demonstration campaign (SYNTHETIC)

This campaign runs on two **constructed** price series with a pattern planted on purpose. It demonstrates the workflow end to end. It is not market data, and nothing it finds is evidence of a tradeable edge. No real gold or FX hypothesis qualifies today (see [`docs/horizon/LEDGER.md`](../../horizon/LEDGER.md)), and eligibility was not relaxed to admit one.

Files: [`campaign.json`](campaign.json) (the declaration). The two CSV fixtures are generated, not committed; the generator is deterministic and the declaration pins their SHA-256.

## Reproduce

Needs PostgreSQL with migrations applied (`pnpm db:deploy`), a built tree (`pnpm build`) and a clean checkout. From `docs/evidence/demo`:

```bash
CLI="node ../../../apps/worker/dist/src/research/campaign-cli.js"
$CLI synthetic-fixture fx-breakout synthetic-fx-breakout.csv
$CLI synthetic-fixture volume-spike-4h synthetic-volume-spike-4h.csv
sha256sum synthetic-*.csv                       # must equal the hashes in campaign.json
$CLI plan campaign.json --preflight             # dry run: writes nothing
$CLI create campaign.json --by demo             # prints campaignId
$CLI start <campaignId> --by demo               # prints runId
$CLI work <runId>                               # resumable; run again after any interruption
$CLI status <runId>
```

Every holdout is withheld at this point. To continue one hypothesis that passed walk-forward (`status` shows `PENDING_HOLDOUT` and its unit id):

```bash
$CLI authorize-holdout <unitId> --operator <you> --ttl-hours 1 --note "synthetic demonstration"
$CLI evaluate-holdout <unitId>                  # reads the holdout once; a second call reads nothing
```

For the ML 2.0 unit on the volume-spike series, if its holdout verdict is `CANDIDATE`:

```bash
$CLI register-model <unitId> --by demo --instrument-key SYNTHETIC:SYN-SPIKE-4H --max-staleness-days 730
$CLI observe <modelVersionId> --operator <you> --reason "synthetic demonstration"
```

The model is then `SHADOW_CANDIDATE`. It is scored only by the shadow service (`GENESIS_SHADOW_ENABLED=true`) and only on a `SYNTHETIC:` instrument key, for which the warehouse holds no bars, so it records nothing in a real deployment. Scoring of a frozen campaign model, with duplicate prevention and horizon timing, is exercised by `apps/worker/src/research/campaign-shadow.integration.test.ts`.

## What a real campaign needs instead

A warehouse dataset id in place of the file source, and `"synthetic": false`:

```json
{ "key": "xau-1h", "source": { "kind": "WAREHOUSE", "datasetId": "<HistoricalDataset.id>" }, "market": "GOLD", "instrument": "XAU_USD", "interval": "1h", "asOf": "2026-11-06T00:00:00Z" }
```

This was not run: the local database has no warehouse history, and production was not touched. The recorded results of the last observed run are in [`RESULTS.md`](RESULTS.md).
