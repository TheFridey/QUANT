import { DEFAULT_STORAGE_QUOTA, type StorageQuota } from "./prisma-backfill-store.js";

/**
 * HELIOS: opt-in storage quota for a bounded historical acquisition (for example 10 years of XAU_USD M1, about
 * 3.8 M bars). Without flags the deployed default applies unchanged (200,000 bars per dataset, 5 M in total).
 *
 *   --max-bars-per-dataset=N   1 .. 6,000,000
 *   --max-total-bars=N         N .. 8,000,000, and never below --max-bars-per-dataset
 *
 * Values outside the bounds are refused rather than clamped, so a typo cannot silently allow a larger download.
 * Sized from the October 2025 pilot: about 593 bytes of database per M1 bar including indexes and raw batch, so
 * the ceilings bound the warehouse at roughly 3.6 GB (dataset) and 4.8 GB (total).
 */
export const QUOTA_CEILINGS = Object.freeze({ maxBarsPerDataset: 6_000_000, maxTotalBars: 8_000_000 });

function flag(args: readonly string[], name: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
}

function positiveInt(text: string, name: string): number {
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`--${name} must be a positive integer`);
  return Number(text);
}

export function storageQuotaFromArgs(args: readonly string[]): StorageQuota {
  const perText = flag(args, "max-bars-per-dataset");
  const totalText = flag(args, "max-total-bars");
  const per = perText === undefined ? DEFAULT_STORAGE_QUOTA.maxBarsPerDataset : positiveInt(perText, "max-bars-per-dataset");
  const total = totalText === undefined ? Math.max(DEFAULT_STORAGE_QUOTA.maxTotalBars, per) : positiveInt(totalText, "max-total-bars");
  if (per > QUOTA_CEILINGS.maxBarsPerDataset) throw new Error(`--max-bars-per-dataset above ${QUOTA_CEILINGS.maxBarsPerDataset}`);
  if (total > QUOTA_CEILINGS.maxTotalBars) throw new Error(`--max-total-bars above ${QUOTA_CEILINGS.maxTotalBars}`);
  if (total < per) throw new Error("--max-total-bars must not be below --max-bars-per-dataset");
  return { maxBarsPerDataset: per, maxTotalBars: total };
}

/** Positional arguments only (flags removed), so existing invocations keep working unchanged. */
export function positionalArgs(args: readonly string[]): string[] {
  return args.filter((a) => !a.startsWith("--"));
}
