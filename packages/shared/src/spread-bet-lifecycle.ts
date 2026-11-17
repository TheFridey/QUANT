import { AURUM_ORDER_ACTIONS, type AurumOrderAction } from "./aurum-scope.js";
import type { Direction } from "./spread-bet.js";

/**
 * OPERATION AURUM: spread-bet position state machine. **Pure and unwired.**
 * Formal table in docs/aurum/EXECUTION-STATE-MACHINE.md. Terminal states never transition.
 * Direction is a property of the position, never inferred from an order side.
 */

export const SPREAD_POSITION_STATES = [
  "PENDING_ENTRY",
  "OPEN",
  "PARTIALLY_CLOSED",
  "EXIT_PENDING",
  "CLOSED",
  "CANCELLED",
  "REJECTED",
] as const;
export type SpreadPositionState = (typeof SPREAD_POSITION_STATES)[number];

export const TERMINAL_STATES: readonly SpreadPositionState[] = ["CLOSED", "CANCELLED", "REJECTED"];

export type LifecycleEvent =
  | { type: "ENTRY_FILLED" }
  | { type: "ENTRY_REJECTED" }
  | { type: "ENTRY_CANCELLED" }
  | { type: "ENTRY_EXPIRED" }
  | { type: "EXIT_REQUESTED" }
  | { type: "EXIT_CANCELLED"; remainingStake: "PARTIAL" | "FULL" }
  | { type: "EXIT_FILLED"; remainingStake: "ZERO" | "PARTIAL" }
  | { type: "PARTIAL_EXIT_FILLED" };

const TABLE: Record<SpreadPositionState, Partial<Record<LifecycleEvent["type"], SpreadPositionState | ((e: LifecycleEvent) => SpreadPositionState)>>> = {
  PENDING_ENTRY: { ENTRY_FILLED: "OPEN", ENTRY_REJECTED: "REJECTED", ENTRY_CANCELLED: "CANCELLED", ENTRY_EXPIRED: "CANCELLED" },
  OPEN: { EXIT_REQUESTED: "EXIT_PENDING", PARTIAL_EXIT_FILLED: "PARTIALLY_CLOSED" },
  PARTIALLY_CLOSED: { EXIT_REQUESTED: "EXIT_PENDING", PARTIAL_EXIT_FILLED: "PARTIALLY_CLOSED" },
  EXIT_PENDING: {
    EXIT_FILLED: (e) => (e.type === "EXIT_FILLED" && e.remainingStake === "ZERO" ? "CLOSED" : "PARTIALLY_CLOSED"),
    EXIT_CANCELLED: (e) => (e.type === "EXIT_CANCELLED" && e.remainingStake === "FULL" ? "OPEN" : "PARTIALLY_CLOSED"),
  },
  CLOSED: {},
  CANCELLED: {},
  REJECTED: {},
};

export function nextSpreadPositionState(
  state: SpreadPositionState,
  event: LifecycleEvent,
): { ok: true; state: SpreadPositionState } | { ok: false; reason: "TERMINAL_STATE" | "ILLEGAL_TRANSITION" } {
  if (TERMINAL_STATES.includes(state)) return { ok: false, reason: "TERMINAL_STATE" };
  const rule = TABLE[state]?.[event.type];
  if (rule === undefined) return { ok: false, reason: "ILLEGAL_TRANSITION" };
  return { ok: true, state: typeof rule === "function" ? rule(event) : rule };
}

/**
 * Whether an action is valid against an existing position. Opening actions are only valid with no open
 * position (no netting, no pyramiding, no averaging down); reduce/close actions must match direction.
 */
export function actionValidFor(
  action: AurumOrderAction,
  position: { direction: Direction; state: SpreadPositionState } | null,
): { ok: true } | { ok: false; reason: "UNKNOWN_ACTION" | "POSITION_ALREADY_OPEN" | "NO_OPEN_POSITION" | "DIRECTION_MISMATCH" | "EXIT_ALREADY_PENDING" } {
  if (!(AURUM_ORDER_ACTIONS as readonly string[]).includes(action)) return { ok: false, reason: "UNKNOWN_ACTION" };
  const live = position !== null && (position.state === "OPEN" || position.state === "PARTIALLY_CLOSED" || position.state === "EXIT_PENDING" || position.state === "PENDING_ENTRY");
  if (action === "CANCEL_ORDER") return { ok: true };
  if (action === "OPEN_LONG" || action === "OPEN_SHORT") return live ? { ok: false, reason: "POSITION_ALREADY_OPEN" } : { ok: true };
  if (!live || position.state === "PENDING_ENTRY") return { ok: false, reason: "NO_OPEN_POSITION" };
  if (position.state === "EXIT_PENDING") return { ok: false, reason: "EXIT_ALREADY_PENDING" };
  const wanted: Direction = action.endsWith("_LONG") ? "LONG" : "SHORT";
  return position.direction === wanted ? { ok: true } : { ok: false, reason: "DIRECTION_MISMATCH" };
}
