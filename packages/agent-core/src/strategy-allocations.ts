/**
 * Re-export allocation settlement from trading-engine (runtime authority).
 * Kept here so existing agent-core imports continue to work without circular deps
 * (agent-core → trading-engine; trading-engine does not import agent-core).
 */
export {
  applyAllocationFill,
  allocationVenueDrift,
  distributeProRata,
  instanceAvailableUsd,
  maxCloseableAllocationQty,
  netAllocationQty,
  releaseExitQty,
  repairAllocationDrift,
  reserveExitQty,
  settleFillByOwnerScope,
  type AllocationView,
  type OwnerScope,
  type StrategyAllocationStore,
} from "@odin/trading-engine";
