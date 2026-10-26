import {
  SEED_INSTRUMENTS,
  assertCompatibleInstruments,
  canPaperExecute,
  type Instrument,
  type MarketSelection,
} from "@odin/shared";

export type InstrumentRegistry = {
  instruments: Instrument[];
  selections: Map<string, boolean>;
};

export function createInstrumentRegistry(
  instruments: Instrument[] = SEED_INSTRUMENTS,
  selections?: MarketSelection[],
): InstrumentRegistry {
  const map = new Map<string, boolean>();
  for (const instrument of instruments) {
    map.set(instrument.id, instrument.enabledByDefault);
  }
  for (const selection of selections ?? []) {
    if (map.has(selection.instrumentId)) {
      map.set(selection.instrumentId, selection.enabled);
    }
  }
  return { instruments, selections: map };
}

export function enabledInstruments(registry: InstrumentRegistry): Instrument[] {
  return registry.instruments.filter((instrument) => registry.selections.get(instrument.id) === true);
}

export function setMarketEnabled(
  registry: InstrumentRegistry,
  instrumentId: string,
  enabled: boolean,
): InstrumentRegistry {
  if (!registry.instruments.some((instrument) => instrument.id === instrumentId)) {
    throw new Error(`Unknown instrument: ${instrumentId}`);
  }
  const selections = new Map(registry.selections);
  selections.set(instrumentId, enabled);
  return { instruments: registry.instruments, selections };
}

export function validateStrategyUniverse(instrumentIds: string[], registry: InstrumentRegistry) {
  const selected = instrumentIds.map((id) => {
    const instrument = registry.instruments.find((row) => row.id === id);
    if (!instrument) throw new Error(`Unknown instrument: ${id}`);
    return instrument;
  });
  const compatibility = assertCompatibleInstruments(selected);
  if (!compatibility.ok) {
    return { ok: false as const, reason: compatibility.reason ?? "incompatible" };
  }
  const paperAttempt = selected.filter((instrument) => canPaperExecute(instrument));
  const researchOnly = selected.filter((instrument) => !canPaperExecute(instrument));
  if (paperAttempt.length > 0 && researchOnly.length > 0) {
    return {
      ok: false as const,
      reason: "Cannot mix paper-executable markets with research-only indices in one strategy",
    };
  }
  return { ok: true as const, instruments: selected };
}
