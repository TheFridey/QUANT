import { decimalStringFromJson, primitives } from "./numbers.js";
import type { Candle, HistoricalProvider, HolderStats, ProviderResult, TokenSecurity } from "./provider.js";

const BASE = "https://public-api.birdeye.so";

const BIRDEYE_TIMEOUT_MS = 4_000;

export class BirdeyeClient implements HistoricalProvider {
  readonly id = "birdeye";

  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getOhlcv(
    tokenAddress: string,
    interval: "15m" | "1H" | "4H" | "1D",
    timeFrom: number,
    timeTo: number,
  ): Promise<ProviderResult<Candle[]>> {
    const blocked = this.guard();
    if (blocked) return blocked;
    const url = new URL(`${BASE}/defi/ohlcv`);
    url.searchParams.set("address", tokenAddress);
    url.searchParams.set("type", interval);
    url.searchParams.set("time_from", String(timeFrom));
    url.searchParams.set("time_to", String(timeTo));
    const body = await this.get(url);
    if (!body.ok) return body;
    return { ok: true, fetchedAt: new Date().toISOString(), data: parseCandles(body.data) };
  }

  async getTokenSecurity(tokenAddress: string): Promise<ProviderResult<TokenSecurity>> {
    const blocked = this.guard();
    if (blocked) return blocked;
    const url = new URL(`${BASE}/defi/token_security`);
    url.searchParams.set("address", tokenAddress);
    const body = await this.get(url);
    if (!body.ok) return body;
    const data = dataRecord(body.data);
    if (!data) return { ok: false, code: "INVALID", error: "Birdeye security payload has no data object" };
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      data: { tokenAddress, fields: primitives(data) },
    };
  }

  async getHolders(tokenAddress: string): Promise<ProviderResult<HolderStats>> {
    const blocked = this.guard();
    if (blocked) return blocked;
    const url = new URL(`${BASE}/defi/v3/token/holder`);
    url.searchParams.set("address", tokenAddress);
    const body = await this.get(url);
    if (!body.ok) return body;
    const data = dataRecord(body.data);
    if (!data) return { ok: false, code: "INVALID", error: "Birdeye holder payload has no data object" };
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      data: {
        tokenAddress,
        holderCount: holderCount(data),
        fields: primitives(data),
      },
    };
  }

  private guard(): ProviderResult<never> | null {
    if (!this.apiKey) {
      return { ok: false, code: "UNAVAILABLE", error: "BIRDEYE_API_KEY is not configured" };
    }
    return null;
  }

  private async get(url: URL): Promise<{ ok: true; data: unknown } | ProviderResult<never>> {
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          accept: "application/json",
          "X-API-KEY": this.apiKey ?? "",
          "x-chain": "solana",
        },
        signal: AbortSignal.timeout(BIRDEYE_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { ok: false, code: "UPSTREAM", error: `Birdeye HTTP ${response.status}` };
      }
      return { ok: true, data: await response.json() };
    } catch (error) {
      return { ok: false, code: "UPSTREAM", error: error instanceof Error ? error.message : "Birdeye request failed" };
    }
  }
}

export function parseCandles(body: unknown): Candle[] {
  const data = dataRecord(body);
  const items = data && Array.isArray(data.items) ? data.items : [];
  const candles: Candle[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const time = typeof row.unixTime === "number" ? row.unixTime : null;
    const open = decimalStringFromJson(row.o);
    const high = decimalStringFromJson(row.h);
    const low = decimalStringFromJson(row.l);
    const close = decimalStringFromJson(row.c);
    if (time === null || open === null || high === null || low === null || close === null) continue;
    candles.push({
      time,
      open,
      high,
      low,
      close,
      volume: decimalStringFromJson(row.v),
    });
  }
  return candles;
}

function dataRecord(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

function holderCount(data: Record<string, unknown>): string | null {
  for (const key of ["total", "holder", "holders", "holderCount"]) {
    const value = decimalStringFromJson(data[key]);
    if (value !== null) return value;
  }
  return null;
}
