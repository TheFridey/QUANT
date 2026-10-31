import { DEFAULT_STRATEGY, parseStrategyConfig, type StrategyConfig } from "@odin/shared";

type ConfigIssue = { path: PropertyKey[]; message: string };

/**
 * Audit H1 (review F1): a stored config that fails validation is never healed or rewritten,
 * and it never stops risk reduction. Entries are blocked (pauseNewEntries) while settlement,
 * planned exits and protection run on DEFAULT_STRATEGY, the authoritative defaults, until the
 * operator corrects the fields named in the CONFIG_INVALID alert.
 */
export function strategyConfigOrExitOnly(raw: unknown): { config: StrategyConfig; issues: ConfigIssue[] | null } {
  try {
    return { config: parseStrategyConfig(raw), issues: null };
  } catch (error) {
    const issues = (error as { issues?: ConfigIssue[] }).issues ?? [{ path: [], message: String(error) }];
    return { config: { ...DEFAULT_STRATEGY, pauseNewEntries: true }, issues };
  }
}
