import { findInstrument, type MarketSelection } from "@odin/shared";

/**
 * Map a cycle pair / position address onto the MarketSelection instrument id.
 * Multi-market ids are already `fx:…` / `etf:…`; Solana discovery pairs collapse
 * to the universe instrument that operators toggle.
 */
export function resolveMarketInstrumentId(pair: {
  pairAddress: string;
  chainId?: string | null;
}): string {
  const address = pair.pairAddress.trim();
  if (!address) return "solana:spot:universe";
  if (findInstrument(address)) return address;
  if (address.includes(":")) {
    const prefix = address.split(":")[0];
    if (prefix === "fx" || prefix === "etf" || prefix === "commodity" || prefix === "index") {
      return address;
    }
  }
  if (pair.chainId === "fx" || pair.chainId === "etf" || pair.chainId === "commodity") {
    return address.includes(":") ? address : `${pair.chainId}:${address}`;
  }
  return "solana:spot:universe";
}

/** Load selections into an instrumentId → enabled map (defaults applied by caller). */
export function marketSelectionMap(
  selections: Iterable<MarketSelection | { instrumentId: string; enabled: boolean }>,
): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const row of selections) {
    map.set(row.instrumentId, row.enabled);
  }
  return map;
}

/**
 * Automatic ENTRY admission under MarketSelection.
 * Missing map ⇒ ungated (legacy). Missing instrument key ⇒ treat as disabled only
 * when the map is non-empty and the instrument was explicitly set false; unknown
 * ids default to enabled so partial selection rows do not blanket-block.
 * Disabled markets never block EXIT / monitoring of open holdings.
 */
export function isAutomaticEntryEnabled(
  pair: { pairAddress: string; chainId?: string | null },
  marketEntryEnabled: ReadonlyMap<string, boolean> | null | undefined,
): boolean {
  if (!marketEntryEnabled) return true;
  const instrumentId = resolveMarketInstrumentId(pair);
  if (!marketEntryEnabled.has(instrumentId)) return true;
  return marketEntryEnabled.get(instrumentId) === true;
}
