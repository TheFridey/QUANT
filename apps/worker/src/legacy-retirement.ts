import type { StrategyConfig } from "@odin/shared";

/**
 * OPERATION AURUM / CATALYST: reversible retirement of legacy Solana discovery and crypto entries.
 *
 *   LEGACY_CRYPTO_MODE=ACTIVE   (default; today's behaviour, unchanged)
 *   LEGACY_CRYPTO_MODE=RETIRED  discovery off, new entries paused
 *
 * RETIRED does three things and nothing else:
 * 1. The Solana discovery call (`fetchUniverse`) is not made, so no new pairs are observed, assessed or evaluated.
 * 2. `pauseNewEntries` is forced true on the resolved strategy config. This only tightens: it never turns a
 *    stored `pauseNewEntries: true` off, and it is enforced by the existing planner and risk engine.
 * 3. A cycle with nothing to observe records its state on the CycleRun row instead of writing a permanent
 *    REJECT AgentDecision every cycle.
 *
 * Untouched on purpose: the mandatory mark refresh for open, pending and protected instruments; exit
 * evaluation, protection, settlement and reconciliation; every historical row; capital, HWM, daily-loss and
 * drawdown state; dashboards and accounting. There is no switch for protective exits.
 *
 * The value is read once when the worker starts. Reversal: set ACTIVE (or remove the variable) and restart the
 * worker. Anything other than ACTIVE or RETIRED is treated as RETIRED, which is the side that only reduces
 * activity, and is reported so the typo is visible.
 */

export const LEGACY_CRYPTO_MODES = ["ACTIVE", "RETIRED"] as const;
export type LegacyCryptoMode = (typeof LEGACY_CRYPTO_MODES)[number];

export type LegacyRetirement = {
  mode: LegacyCryptoMode;
  discoveryEnabled: boolean;
  newEntriesEnabled: boolean;
  /** Set when the variable was present but not a recognised value. */
  issue: string | null;
};

export function legacyRetirementFromEnv(env: NodeJS.ProcessEnv = process.env): LegacyRetirement {
  const raw = env.LEGACY_CRYPTO_MODE;
  if (raw === undefined || raw.trim() === "" || raw.trim().toUpperCase() === "ACTIVE") {
    return { mode: "ACTIVE", discoveryEnabled: true, newEntriesEnabled: true, issue: null };
  }
  const issue = raw.trim().toUpperCase() === "RETIRED" ? null : `UNRECOGNISED_LEGACY_CRYPTO_MODE:${raw.slice(0, 32)}`;
  return { mode: "RETIRED", discoveryEnabled: false, newEntriesEnabled: false, issue };
}

/** Applies retirement to a resolved strategy config. Only ever sets `pauseNewEntries` to true. */
export function applyLegacyRetirement(config: StrategyConfig, retirement: LegacyRetirement): StrategyConfig {
  if (retirement.newEntriesEnabled) return config;
  return config.pauseNewEntries === true ? config : { ...config, pauseNewEntries: true };
}
