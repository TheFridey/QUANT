/**
 * Deterministic clock shared by backtest replay and runtime protection evaluation.
 * Production callers use system clock; tests/replay inject fixed or stepped time.
 */
export type Clock = {
  now(): Date;
  /** Milliseconds since Unix epoch — same instant as now(). */
  nowMs(): number;
};

export function systemClock(): Clock {
  return {
    now: () => new Date(),
    nowMs: () => Date.now(),
  };
}

/** Fixed clock for pure unit tests. */
export function fixedClock(isoOrDate: string | Date): Clock {
  const date = typeof isoOrDate === "string" ? new Date(isoOrDate) : new Date(isoOrDate.getTime());
  return {
    now: () => new Date(date.getTime()),
    nowMs: () => date.getTime(),
  };
}

/**
 * Stepped clock: starts at `start`, advances only via `advance(ms)`.
 * Used by replay/runtime parity harnesses so exit/time rules share one timeline.
 */
export function steppedClock(start: string | Date): Clock & { advance(ms: number): Date; set(iso: string | Date): Date } {
  let ms = (typeof start === "string" ? Date.parse(start) : start.getTime());
  return {
    now: () => new Date(ms),
    nowMs: () => ms,
    advance(deltaMs: number) {
      ms += deltaMs;
      return new Date(ms);
    },
    set(iso: string | Date) {
      ms = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
      return new Date(ms);
    },
  };
}

/** Parse observation / event time into epoch ms; null if invalid. */
export function eventTimeMs(iso: string | Date | null | undefined): number | null {
  if (iso == null) return null;
  const ms = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  return Number.isFinite(ms) ? ms : null;
}
