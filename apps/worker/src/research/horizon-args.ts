/** Argument handling for horizon-cli, kept free of the database so it can be unit-tested. */

export type HorizonMarket = "CRYPTO" | "GOLD" | "FX" | "ETF";

export type HorizonCliArgs = {
  datasetId: string | null;
  csvPath: string | null;
  interval: string | null;
  market: HorizonMarket;
  /** null = the dataset's instrumentKey (warehouse); required for CSV. */
  instrument: string | null;
  /** null = read the programme trial count from the registry (warehouse); required for CSV. */
  priorTrials: number | null;
  ml: boolean;
  mlHorizons: "PRIMARY" | "ALL";
  strategies: string[] | null;
  folds: number | null;
  seed: number | null;
  /** Cost overrides: fee in bps per side; spread (full) and slippage (per side) in the market's own unit. */
  feeBps: number | null;
  spread: number | null;
  slippage: number | null;
};

export const HORIZON_CLI_USAGE =
  "usage: horizon-cli (<datasetId> | --csv <path> --instrument SYM --prior-trials N [--interval 1h]) --market CRYPTO|GOLD|FX|ETF [--instrument SYM] [--prior-trials N] [--ml on|off] [--ml-horizons PRIMARY|ALL] [--strategies id,id] [--folds N] [--seed N] [--fee-bps N] [--spread N] [--slippage N]";

const INT_FLAGS = new Set(["--prior-trials", "--folds", "--seed"]);
const NUM_FLAGS = new Set(["--fee-bps", "--spread", "--slippage"]);
const ENUMS: Record<string, readonly string[]> = {
  "--market": ["CRYPTO", "GOLD", "FX", "ETF"],
  "--ml": ["on", "off"],
  "--ml-horizons": ["PRIMARY", "ALL"],
};
const STR_FLAGS = new Set(["--csv", "--interval", "--instrument", "--strategies"]);

/** Strict: known flags only, each with a value; exactly one source; an explicit market. */
export function parseHorizonArgs(args: readonly string[]): HorizonCliArgs {
  const out: HorizonCliArgs = { datasetId: null, csvPath: null, interval: null, market: "CRYPTO", instrument: null, priorTrials: null, ml: true, mlHorizons: "PRIMARY", strategies: null, folds: null, seed: null, feeBps: null, spread: null, slippage: null };
  let market: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const v = args[i + 1];
    if (v === undefined) throw new Error(`${a} needs a value`);
    i += 1;
    if (INT_FLAGS.has(a)) {
      const n = Number(v);
      const min = a === "--folds" ? 2 : 0;
      if (!Number.isInteger(n) || n < min) throw new Error(`${a} needs an integer ≥ ${min}`);
      if (a === "--prior-trials") out.priorTrials = n;
      else if (a === "--folds") out.folds = n;
      else out.seed = n;
    } else if (NUM_FLAGS.has(a)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${a} needs a non-negative number`);
      if (a === "--fee-bps") out.feeBps = n;
      else if (a === "--spread") out.spread = n;
      else out.slippage = n;
    } else if (a in ENUMS) {
      if (!ENUMS[a]!.includes(v)) throw new Error(`${a} must be one of ${ENUMS[a]!.join(", ")}`);
      if (a === "--market") market = v;
      else if (a === "--ml") out.ml = v === "on";
      else out.mlHorizons = v as HorizonCliArgs["mlHorizons"];
    } else if (STR_FLAGS.has(a)) {
      if (a === "--csv") out.csvPath = v;
      else if (a === "--interval") out.interval = v;
      else if (a === "--instrument") out.instrument = v;
      else {
        const ids = v.split(",").map((s) => s.trim()).filter(Boolean);
        if (!ids.length) throw new Error("--strategies needs at least one id");
        out.strategies = ids;
      }
    } else {
      throw new Error(`unknown option ${a}`);
    }
  }
  if (positional.length > 1) throw new Error(`unexpected arguments: ${positional.slice(1).join(" ")}`);
  out.datasetId = positional[0] ?? null;
  if ((out.datasetId === null) === (out.csvPath === null)) throw new Error("give exactly one source: a dataset id or --csv <path>");
  if (market === null) throw new Error("--market is required (no market is assumed)");
  out.market = market as HorizonMarket;
  if (out.csvPath !== null && out.instrument === null) throw new Error("--csv needs --instrument (pip size and costs depend on it)");
  // A CSV run cannot read the registry, so the programme-wide trial count must be stated, never assumed zero.
  if (out.csvPath !== null && out.priorTrials === null) throw new Error("--csv needs --prior-trials (programme-wide multiple testing)");
  return out;
}
