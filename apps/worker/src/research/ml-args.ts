/** Argument and CSV handling for ml-cli, kept free of the database so it can be unit-tested. */

export type MlCliArgs = {
  datasetId: string | null;
  csvPath: string | null;
  interval: string | null;
  horizon: number | null;
  feeBps: number | null;
  slippageBps: number | null;
  stopPct: number | null;
  targetPct: number | null;
  target: "NET_POSITIVE" | "TARGET_BEFORE_STOP";
  scheme: "EXPANDING" | "ROLLING";
  calibration: "PLATT" | "ISOTONIC" | "NONE";
  folds: number | null;
  seed: number | null;
  priorTrials: number | null;
};

export const ML_CLI_USAGE =
  "usage: ml-cli (<datasetId> | --csv <path> --fee-bps N --slippage-bps N [--interval 1h]) [--horizon N] [--stop-pct X] [--target-pct X] [--target NET_POSITIVE|TARGET_BEFORE_STOP] [--scheme EXPANDING|ROLLING] [--calibration PLATT|ISOTONIC|NONE] [--folds N] [--seed N] [--prior-trials N]";

const INT_FLAGS = new Set(["--horizon", "--folds", "--seed", "--prior-trials"]);
const NUM_FLAGS = new Set(["--fee-bps", "--slippage-bps", "--stop-pct", "--target-pct"]);
const ENUMS: Record<string, readonly string[]> = {
  "--target": ["NET_POSITIVE", "TARGET_BEFORE_STOP"],
  "--scheme": ["EXPANDING", "ROLLING"],
  "--calibration": ["PLATT", "ISOTONIC", "NONE"],
};
const STR_FLAGS = new Set(["--csv", "--interval"]);

/** Strict: known flags only, each with a value; exactly one source (dataset id or --csv). */
export function parseMlArgs(args: readonly string[]): MlCliArgs {
  const out: MlCliArgs = { datasetId: null, csvPath: null, interval: null, horizon: null, feeBps: null, slippageBps: null, stopPct: null, targetPct: null, target: "NET_POSITIVE", scheme: "EXPANDING", calibration: "PLATT", folds: null, seed: null, priorTrials: null };
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
      if (!Number.isInteger(n) || n < (a === "--prior-trials" || a === "--seed" ? 0 : 1)) throw new Error(`${a} needs a ${a === "--prior-trials" || a === "--seed" ? "non-negative" : "positive"} integer`);
      if (a === "--horizon") out.horizon = n;
      else if (a === "--folds") out.folds = n;
      else if (a === "--seed") out.seed = n;
      else out.priorTrials = n;
    } else if (NUM_FLAGS.has(a)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${a} needs a non-negative number`);
      if (a === "--fee-bps") out.feeBps = n;
      else if (a === "--slippage-bps") out.slippageBps = n;
      else if (a === "--stop-pct") out.stopPct = n;
      else out.targetPct = n;
    } else if (a in ENUMS) {
      if (!ENUMS[a]!.includes(v)) throw new Error(`${a} must be one of ${ENUMS[a]!.join(", ")}`);
      if (a === "--target") out.target = v as MlCliArgs["target"];
      else if (a === "--scheme") out.scheme = v as MlCliArgs["scheme"];
      else out.calibration = v as MlCliArgs["calibration"];
    } else if (STR_FLAGS.has(a)) {
      if (a === "--csv") out.csvPath = v;
      else out.interval = v;
    } else {
      throw new Error(`unknown option ${a}`);
    }
  }
  if (positional.length > 1) throw new Error(`unexpected arguments: ${positional.slice(1).join(" ")}`);
  out.datasetId = positional[0] ?? null;
  if ((out.datasetId === null) === (out.csvPath === null)) throw new Error("give exactly one source: a dataset id or --csv <path>");
  if (out.csvPath !== null && (out.feeBps === null || out.slippageBps === null)) throw new Error("--csv needs --fee-bps and --slippage-bps (no cost is assumed)");
  if (out.target === "TARGET_BEFORE_STOP" && (out.stopPct === null || out.targetPct === null)) throw new Error("--target TARGET_BEFORE_STOP needs --stop-pct and --target-pct");
  return out;
}

export type CsvBar = { t: number; open: number; high: number; low: number; close: number; volume: number | null };

/**
 * Parses `time,open,high,low,close,volume` (header required, any column order, case-insensitive). `time` is
 * the bar OPEN as epoch milliseconds or an ISO-8601 timestamp with a zone. Rows are returned as given: no
 * sorting, de-duplication or repair, so the pipeline's integrity checks see the data exactly as supplied.
 */
export function parseBarsCsv(text: string): CsvBar[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) throw new Error("CSV is empty");
  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const col = (name: string) => {
    const k = header.indexOf(name);
    if (k < 0) throw new Error(`CSV header lacks column "${name}" (need time,open,high,low,close,volume)`);
    return k;
  };
  const idx = { time: col("time"), open: col("open"), high: col("high"), low: col("low"), close: col("close"), volume: col("volume") };
  return lines.slice(1).map((line, k) => {
    const cells = line.split(",").map((c) => c.trim());
    const lineNo = k + 2;
    const rawT = cells[idx.time] ?? "";
    let t: number;
    if (/^\d+$/.test(rawT)) t = Number(rawT);
    else if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(rawT)) t = Date.parse(rawT);
    else throw new Error(`CSV line ${lineNo}: time "${rawT}" is neither epoch ms nor ISO-8601 with a zone`);
    if (!Number.isFinite(t)) throw new Error(`CSV line ${lineNo}: invalid time "${rawT}"`);
    const num = (name: keyof typeof idx) => {
      const v = Number(cells[idx[name]]);
      if (cells[idx[name]] === undefined || cells[idx[name]] === "" || !Number.isFinite(v)) throw new Error(`CSV line ${lineNo}: invalid ${name} "${cells[idx[name]] ?? ""}"`);
      return v;
    };
    const rawV = cells[idx.volume] ?? "";
    return { t, open: num("open"), high: num("high"), low: num("low"), close: num("close"), volume: rawV === "" ? null : num("volume") };
  });
}
