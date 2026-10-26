/** In-process observability counters for research / paper ops. Persisted separately as ObservabilityEvent rows. */

export type ObservabilityCategory =
  | "provider_api"
  | "ai_tokens"
  | "signal_latency"
  | "queue_delay"
  | "data_freshness"
  | "failed_jobs"
  | "portfolio_reconciliation"
  | "risk_violation"
  | "simulation_uptime";

export type ObservabilityCounter = {
  category: ObservabilityCategory;
  name: string;
  value: number;
  unit: string;
  meta?: Record<string, unknown>;
  at: string;
};

export class ObservabilityRegistry {
  private readonly events: ObservabilityCounter[] = [];

  record(event: Omit<ObservabilityCounter, "at"> & { at?: string }): ObservabilityCounter {
    const row: ObservabilityCounter = {
      ...event,
      at: event.at ?? new Date().toISOString(),
    };
    this.events.push(row);
    return row;
  }

  snapshot(): ObservabilityCounter[] {
    return [...this.events];
  }

  totalsByCategory(): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const event of this.events) {
      totals[event.category] = (totals[event.category] ?? 0) + event.value;
    }
    return totals;
  }

  clear(): void {
    this.events.length = 0;
  }
}

export const globalObservability = new ObservabilityRegistry();
