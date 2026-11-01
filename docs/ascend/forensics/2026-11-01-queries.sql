-- ASCEND-00 production forensics, run 1 Nov 2026 ~11:00Z against the VPS database.
-- Read-only: psql is started with PGOPTIONS='-c default_transaction_read_only=on'.
--   ssh scalesmiths "cd /tmp && sudo -u postgres PGOPTIONS='-c default_transaction_read_only=on' psql -d quant -X" < this-file
-- Timestamps in the database are UTC (timestamp without time zone).

-- 1. Account state.
select id, "cashUsd", "startingBalanceUsd", "highWaterMarkUsd", "sessionStartEquityUsd", "sessionStartedAt" from "PaperAccount";

-- 2. Equity per cycle around the breach.
select "createdAt", "cashUsd", "equityUsd", "unrealizedPnlUsd", "exposureUsd", valuation, "highWaterMarkUsd"
from "EquitySnapshot" where "createdAt" between '2026-10-31 15:40' and '2026-10-31 16:10' order by "createdAt";

-- 3. Circuit-breaker rejections by hour, and the engine's last transition.
select date_trunc('hour', "createdAt") h, count(*) from "AgentDecision" where 'CIRCUIT_BREAKER' = any("reasonCodes") group by 1 order by 1;
select status, "updatedBy", "updatedAt" from "EngineControl";

-- 4. Every non-filled order (SELL_EXCEEDS_POSITION, SLIPPAGE_LIMIT).
select "createdAt", side, intent, status, "rejectReason", "ownerScope", "baseSymbol", qty from "Order" where status <> 'FILLED' order by "createdAt";

-- 5. Round trips: realised P&L split into mid-to-mid move, slippage and fees, with entry features and MFE/MAE.
-- Mid is reconstructed as fill price / (1 ± slippageBps). MFE/MAE use observations strictly after entry up to exit.
with f as (
  select f.*, o."ownerScope", o."baseSymbol", o."decisionObservationId" dobs,
         row_number() over (partition by f."pairAddress", f.side order by f."createdAt") n
  from "Fill" f join "Order" o on o.id = f."orderId"),
rt as (
  select b."baseSymbol" sym, b."pairAddress" pa, b."createdAt" tin, s."createdAt" tout,
         b."priceUsd" / (1 + b."slippageBps" / 10000) midin, s."priceUsd" / (1 - s."slippageBps" / 10000) midout,
         b."notionalUsd" nin, s."notionalUsd" nout, b."feeUsd" + s."feeUsd" fees, b."slippageBps" sin, s."slippageBps" sout,
         s."ownerScope" exitby, b.dobs, b."observationId" bobs
  from f b join f s on s."pairAddress" = b."pairAddress" and b.side = 'BUY' and s.side = 'SELL' and s.n = b.n),
r as (select rt.*, nin / (1 + sin / 10000) qmin, nout / (1 - sout / 10000) qmout from rt)
select tin, sym, extract(epoch from tout - tin)::int hold_s, exitby,
       round(nout - nin - fees, 2) pnl, round(100 * (midout / midin - 1), 2) mid_pct, round(qmout - qmin, 2) mid_usd,
       round(nin - qmin + qmout - nout, 2) slip_usd, round(fees, 2) fees,
       o."priceChangeM5" m5, o."priceChangeH1" h1, round(o."liquidityUsd") liq,
       round(extract(epoch from tin - o."pairCreatedAt") / 3600, 1) age_h,
       round(100 * (mx.hi / midin - 1), 2) mfe_pct, round(100 * (mx.lo / midin - 1), 2) mae_pct, mx.nobs
from r
left join "MarketObservation" o on o.id = coalesce(r.dobs, r.bobs)
left join lateral (select max("priceUsd") hi, min("priceUsd") lo, count(*) nobs from "MarketObservation" m
                   where m."pairAddress" = r.pa and m."receivedAt" > r.tin and m."receivedAt" <= r.tout) mx on true
order by r.tin;

-- 6. Liquidity floor in force per config revision, inferred from Sentinel's own pass/reject decisions
-- (no config history is stored).
select c."configRevision",
       max(o."liquidityUsd") filter (where 'LIQUIDITY_FLOOR' = any(d."reasonCodes")) max_rejected_liq,
       min(o."liquidityUsd") filter (where d.decision = 'PASS') min_passed_liq
from "AgentDecision" d join "CycleRun" c on c.id = d."cycleId" join "MarketObservation" o on o.id = d.input->>'observationId'
where d.agent = 'SENTINEL' and c."startedAt" between '2026-10-31 12:30' and '2026-11-01 00:00'
group by 1 order by 1;
