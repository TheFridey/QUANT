/** Argument handling for portfolio-cli, kept separate so it can be tested without a database. */

const FLAGS = new Set(["--lookback", "--rebalance"]);

/** Strict parsing: known `--flag N` pairs only; anything else starting with `--` is refused. */
export function parseArgs(args: readonly string[]): { datasetIds: string[]; flags: Record<string, number> } {
  const datasetIds: string[] = [];
  const flags: Record<string, number> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) {
      datasetIds.push(a);
      continue;
    }
    if (!FLAGS.has(a)) throw new Error(`unknown option ${a}`);
    const value = Number(args[i + 1]);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${a} needs a positive integer`);
    flags[a] = value;
    i += 1;
  }
  return { datasetIds, flags };
}

/** Default rebalance spacing: about a month (21 sessions for daily equities, 30 days on a continuous calendar). */
export function defaultRebalanceBars(barMs: number, calendar: "WEEKDAYS" | "CONTINUOUS"): number {
  if (calendar === "WEEKDAYS" && barMs >= 86_400_000) return 21;
  return Math.max(1, Math.round((30 * 86_400_000) / barMs));
}
