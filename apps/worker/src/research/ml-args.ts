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
  /** null = default from the source: dataset instrumentKind EQUITY_ETF → US_EQUITY, otherwise CRYPTO_24_7. */
  calendar: "CRYPTO_24_7" | "US_EQUITY" | null;
  folds: number | null;
  seed: number | null;
  prefixProbes: number | null;
  priorTrials: number | null;
};

export const ML_CLI_USAGE =
  "usage: ml-cli (<datasetId> | --csv <path> --fee-bps N --slippage-bps N [--interval 1h]) [--horizon N] [--stop-pct X] [--target-pct X] [--target NET_POSITIVE|TARGET_BEFORE_STOP] [--scheme EXPANDING|ROLLING] [--calibration PLATT|ISOTONIC|NONE] [--calendar CRYPTO_24_7|US_EQUITY] [--folds N] [--seed N] [--prior-trials N] [--prefix-probes N]";

const INT_FLAGS = new Set(["--horizon", "--folds", "--seed", "--prior-trials", "--prefix-probes"]);
const NUM_FLAGS = new Set(["--fee-bps", "--slippage-bps", "--stop-pct", "--target-pct"]);
const ENUMS: Record<string, readonly string[]> = {
  "--target": ["NET_POSITIVE", "TARGET_BEFORE_STOP"],
  "--scheme": ["EXPANDING", "ROLLING"],
  "--calibration": ["PLATT", "ISOTONIC", "NONE"],
  "--calendar": ["CRYPTO_24_7", "US_EQUITY"],
};
const STR_FLAGS = new Set(["--csv", "--interval"]);

/** Strict: known flags only, each with a value; exactly one source (dataset id or --csv). */
export function parseMlArgs(args: readonly string[]): MlCliArgs {
  const out: MlCliArgs = { datasetId: null, csvPath: null, interval: null, horizon: null, feeBps: null, slippageBps: null, stopPct: null, targetPct: null, target: "NET_POSITIVE", scheme: "EXPANDING", calibration: "PLATT", calendar: null, folds: null, seed: null, prefixProbes: null, priorTrials: null };
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
      else if (a === "--prefix-probes") out.prefixProbes = n;
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
      else if (a === "--calendar") out.calendar = v as MlCliArgs["calendar"];
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

export type CsvBar = { t: number; open: number; high: number; low: number; close: number; volume: number | null; availableAt: number | null };

function parseTime(raw: string, lineNo: number, column: string): number {
  let t: number;
  if (/^\d+$/.test(raw)) t = Number(raw);
  else if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(raw)) t = Date.parse(raw);
  else throw new Error(`CSV line ${lineNo}: ${column} "${raw}" is neither epoch ms nor ISO-8601 with a zone`);
  if (!Number.isFinite(t)) throw new Error(`CSV line ${lineNo}: invalid ${column} "${raw}"`);
  return t;
}

/**
 * Parses `time,open,high,low,close,volume` (header required, any column order, case-insensitive). `time` is
 * the bar OPEN as epoch milliseconds or an ISO-8601 timestamp with a zone. An optional `available_at` column
 * (same formats; a warehouse export carries it) is when the bar became known; it is returned per bar so the
 * caller can drop bars not yet available and the pipeline can refuse any feature available after its decision
 * time. Rows are returned as given: no sorting, de-duplication or repair, so the pipeline's integrity checks
 * see the data exactly as supplied.
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
  const availIdx = header.indexOf("available_at");
  return lines.slice(1).map((line, k) => {
    const cells = line.split(",").map((c) => c.trim());
    const lineNo = k + 2;
    const t = parseTime(cells[idx.time] ?? "", lineNo, "time");
    const rawA = availIdx >= 0 ? (cells[availIdx] ?? "") : "";
    if (availIdx >= 0 && rawA === "") throw new Error(`CSV line ${lineNo}: available_at is empty (the column is present, so every row needs it)`);
    const availableAt = availIdx >= 0 ? parseTime(rawA, lineNo, "available_at") : null;
    const num = (name: keyof typeof idx) => {
      const v = Number(cells[idx[name]]);
      if (cells[idx[name]] === undefined || cells[idx[name]] === "" || !Number.isFinite(v)) throw new Error(`CSV line ${lineNo}: invalid ${name} "${cells[idx[name]] ?? ""}"`);
      return v;
    };
    const rawV = cells[idx.volume] ?? "";
    return { t, open: num("open"), high: num("high"), low: num("low"), close: num("close"), volume: rawV === "" ? null : num("volume"), availableAt };
  });
}
