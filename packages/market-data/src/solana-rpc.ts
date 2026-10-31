import type { ProviderResult } from "./provider.js";

/**
 * Keyless public endpoint. It serves getAccountInfo, but disables getTokenLargestAccounts
 * (HTTP 429 on every attempt, verified 2026-10-31), so holder concentration needs SOLANA_RPC_URL
 * pointed at a dedicated provider.
 */
export const SOLANA_PUBLIC_RPC_URL = "https://api.mainnet-beta.solana.com";
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SPL_TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export type MintExtension = { extension: string; state: Record<string, unknown> };

/** On-chain mint account facts, read with jsonParsed encoding. */
export type MintFacts = {
  mint: string;
  /** Owning program id (SPL Token or Token-2022); anything else is not a token mint. */
  programId: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Raw integer supply (base units). */
  supply: string;
  decimals: number;
  extensions: MintExtension[];
  slot: number | null;
};

export type HolderConcentration = {
  /** Share of supply held by the 10 largest token accounts, in percent (pool vaults included). */
  top10Pct: string;
  accountsSampled: number;
  slot: number | null;
};

/** Read-only Solana JSON-RPC client for token security facts. Never signs or submits anything. */
export class SolanaRpcSecurityClient {
  readonly id = "solana_rpc";

  constructor(
    private readonly rpcUrl: string = SOLANA_PUBLIC_RPC_URL,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 4_000,
  ) {}

  async getMint(mint: string): Promise<ProviderResult<MintFacts>> {
    const response = await this.call("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]);
    if (!response.ok) return response;
    const { result, fetchedAt } = response;
    const value = record(record(result)?.value);
    if (!value) return { ok: false, code: "INVALID", error: "Mint account not found" };
    const data = record(value.data);
    const parsed = record(data?.parsed);
    const info = record(parsed?.info);
    if (!info || parsed?.type !== "mint") return { ok: false, code: "INVALID", error: "Account is not a token mint" };
    const decimals = typeof info.decimals === "number" ? info.decimals : null;
    const supply = typeof info.supply === "string" && /^\d+$/.test(info.supply) ? info.supply : null;
    if (decimals === null || supply === null || typeof value.owner !== "string") {
      return { ok: false, code: "INVALID", error: "Mint account is missing supply, decimals or owner" };
    }
    return {
      ok: true,
      fetchedAt,
      data: {
        mint,
        programId: value.owner,
        mintAuthority: nullableString(info.mintAuthority),
        freezeAuthority: nullableString(info.freezeAuthority),
        supply,
        decimals,
        extensions: parseExtensions(info.extensions),
        slot: slotOf(result),
      },
    };
  }

  async getTopHolderConcentration(mint: string, supply: string): Promise<ProviderResult<HolderConcentration>> {
    if (!/^\d+$/.test(supply) || BigInt(supply) === 0n) {
      return { ok: false, code: "INVALID", error: "Supply is zero or invalid; concentration is undefined" };
    }
    const response = await this.call("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
    if (!response.ok) return response;
    const accounts = record(response.result)?.value;
    if (!Array.isArray(accounts)) return { ok: false, code: "INVALID", error: "getTokenLargestAccounts returned no list" };
    let top10 = 0n;
    let sampled = 0;
    for (const row of accounts.slice(0, 10)) {
      const amount = record(row)?.amount;
      if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
        return { ok: false, code: "INVALID", error: "Holder amount is not an integer string" };
      }
      top10 += BigInt(amount);
      sampled += 1;
    }
    // Percentage with six decimals, computed in integer maths so large supplies keep precision.
    const scaled = (top10 * 100_000_000n) / BigInt(supply);
    const whole = scaled / 1_000_000n;
    const fraction = (scaled % 1_000_000n).toString().padStart(6, "0");
    return {
      ok: true,
      fetchedAt: response.fetchedAt,
      data: { top10Pct: `${whole}.${fraction}`, accountsSampled: sampled, slot: slotOf(response.result) },
    };
  }

  private async call(
    method: string,
    params: unknown[],
  ): Promise<{ ok: true; result: unknown; fetchedAt: string } | Extract<ProviderResult<never>, { ok: false }>> {
    try {
      const response = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return { ok: false, code: "UPSTREAM", error: `Solana RPC HTTP ${response.status} for ${method}` };
      const body = record(await response.json());
      const error = record(body?.error);
      if (error) {
        const code = typeof error.code === "number" ? error.code : "unknown";
        return { ok: false, code: "UPSTREAM", error: `Solana RPC error ${code} for ${method}` };
      }
      if (!body || !("result" in body)) return { ok: false, code: "INVALID", error: `Solana RPC ${method} returned no result` };
      return { ok: true, result: body.result, fetchedAt: new Date().toISOString() };
    } catch (error) {
      // Never echo the URL: a dedicated provider URL can embed an API key.
      return { ok: false, code: "UPSTREAM", error: error instanceof Error ? `${method}: ${error.name}` : `${method} failed` };
    }
  }
}

function parseExtensions(value: unknown): MintExtension[] {
  if (!Array.isArray(value)) return [];
  const out: MintExtension[] = [];
  for (const item of value) {
    const row = record(item);
    if (!row || typeof row.extension !== "string") continue;
    out.push({ extension: row.extension, state: record(row.state) ?? {} });
  }
  return out;
}

function slotOf(result: unknown): number | null {
  const slot = record(record(result)?.context)?.slot;
  return typeof slot === "number" ? slot : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
