import { fxSessionState, seededRng, type ResearchBar } from "@odin/backtest/research";

/**
 * SYNTHETIC FIXTURES. Constructed price series with an edge planted on purpose, used only to demonstrate and
 * test the campaign workflow end to end. They are not market data and a result on them is not evidence of any
 * tradeable edge. A campaign that uses one must declare `synthetic: true`.
 */

const gaussian = (rng: () => number) => Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());

/**
 * Hourly bars on the FX session calendar. About once every `every` bars a wide up bar is followed by `len`
 * bars of upward drift; the base drift offsets it so buy-and-hold has roughly no edge. Breakout families find it.
 */
export function syntheticFxBreakoutBars(input: { start: string; bars: number; seed: number; price0?: number; sigma?: number; plant?: { every: number; jump: number; drift: number; len: number } | null }): ResearchBar[] {
  const hour = 3_600_000;
  const times: number[] = [];
  for (let t = Date.parse(input.start); times.length < input.bars; t += hour) if (fxSessionState(t) === "OPEN") times.push(t);
  const rng = seededRng(input.seed);
  const sigma = input.sigma ?? 0.0015;
  const plant = input.plant === undefined ? { every: 40, jump: 6, drift: 1, len: 12 } : input.plant;
  const base = plant ? -((plant.jump + plant.drift * plant.len) / plant.every) * sigma : 0;
  let p = input.price0 ?? 1.1;
  let remaining = 0;
  return times.map((t) => {
    const open = p;
    let r: number;
    let event = false;
    if (plant && remaining === 0 && rng() < 1 / plant.every) {
      r = plant.jump * sigma;
      remaining = plant.len;
      event = true;
    } else if (plant && remaining > 0) {
      r = plant.drift * sigma + 0.5 * sigma * gaussian(rng);
      remaining -= 1;
    } else {
      r = base + sigma * gaussian(rng);
    }
    p = open * Math.exp(r);
    const high = event ? p * (1 + 0.05 * sigma) : Math.max(open, p) * Math.exp(Math.abs(gaussian(rng)) * 0.3 * sigma);
    const low = event ? open * (1 - 0.05 * sigma) : Math.min(open, p) * Math.exp(-Math.abs(gaussian(rng)) * 0.3 * sigma);
    return { t, open, high, low, close: p, volume: 1000 };
  });
}

/**
 * 24/7 bars where a volume spike (10% of bars) is followed by `boostBars` bars of positive drift and every
 * other bar drifts down, so only the spike reveals the signal. ML 2.0 finds it through volume features.
 */
export function syntheticVolumeSpikeBars(input: { start: string; bars: number; seed: number; barMs: number; boostBars: number; boostDrift?: number; baseDrift?: number; sigma?: number }): ResearchBar[] {
  const rng = seededRng(input.seed);
  // The grid is anchored at `start` itself (bars are aligned relative to the first bar).
  const t0 = Date.parse(input.start);
  const up = input.boostDrift ?? 0.006;
  const down = input.baseDrift ?? -0.0025;
  const sigma = input.sigma ?? 0.006;
  const out: ResearchBar[] = [];
  let p = 100;
  let boost = 0;
  for (let i = 0; i < input.bars; i += 1) {
    const z = gaussian(rng);
    const open = p;
    p = p * Math.exp((boost > 0 ? up : down) + sigma * z);
    if (boost > 0) boost -= 1;
    const spike = rng() < 0.1;
    if (spike) boost = input.boostBars;
    out.push({ t: t0 + i * input.barMs, open, high: Math.max(open, p) * 1.001, low: Math.min(open, p) * 0.999, close: p, volume: (spike ? 5 : 1) * (1 + 0.3 * rng()) });
  }
  return out;
}

/** CSV in the format the campaign FILE source reads (time,open,high,low,close,volume). */
export function barsToCsv(bars: readonly ResearchBar[]): string {
  return ["time,open,high,low,close,volume", ...bars.map((b) => `${new Date(b.t).toISOString()},${b.open},${b.high},${b.low},${b.close},${b.volume ?? ""}`)].join("\n") + "\n";
}
