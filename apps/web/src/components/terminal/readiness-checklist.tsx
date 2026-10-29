"use client";

import Link from "next/link";
import { Panel } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { cn } from "@/lib/utils";

type CheckStatus = "ok" | "warn" | "blocked" | "info";

type CheckItem = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Honest capability label when relevant */
  code?: string;
};

function tone(status: CheckStatus): string {
  switch (status) {
    case "ok":
      return "text-profit";
    case "warn":
      return "text-warning";
    case "blocked":
      return "text-loss";
    default:
      return "text-muted";
  }
}

function statusWord(status: CheckStatus): string {
  switch (status) {
    case "ok":
      return "READY";
    case "warn":
      return "ATTENTION";
    case "blocked":
      return "BLOCKED";
    default:
      return "INFO";
  }
}

function classifyProvider(raw: string | undefined): { status: CheckStatus; code: string; detail: string } {
  const value = (raw ?? "UNKNOWN").toUpperCase();
  if (value === "READY") {
    return { status: "ok", code: "READY", detail: "Practice provider reports READY." };
  }
  if (value === "MISSING_CREDENTIALS") {
    return {
      status: "blocked",
      code: "MISSING_CREDENTIALS",
      detail: "Keys absent — set practice credentials in env; this is not an unimplemented adapter.",
    };
  }
  if (value === "NOT_IMPLEMENTED") {
    return {
      status: "blocked",
      code: "NOT_IMPLEMENTED",
      detail: "Adapter path exists but venue booking is not implemented — credentials alone will not unlock it.",
    };
  }
  if (value === "INVALID_CONFIGURATION" || value === "AUTH_FAILED") {
    return {
      status: "blocked",
      code: value,
      detail: "Configuration or auth failed — fix practice URL/keys; do not treat as LIVE.",
    };
  }
  if (value === "CONNECTING") {
    return { status: "warn", code: "CONNECTING", detail: "Keys present; entitlement/auth not yet READY." };
  }
  return { status: "info", code: value, detail: "See Settings / RUNBOOKS for provider setup." };
}

/** Minimal first-session readiness panel (D23) — checklist, not a full wizard. */
export function ReadinessChecklist({ compact = false }: { compact?: boolean }) {
  const { snapshot, socketState } = useSnapshot();
  if (!snapshot) return null;

  const health = snapshot.health;
  const exec = snapshot.execution;
  const ops = snapshot.opsControls;
  const alpaca = classifyProvider(exec?.providerReadiness?.alpaca_paper ?? ops?.providerReadiness?.alpaca_paper);
  const oanda = classifyProvider(exec?.providerReadiness?.oanda_practice ?? ops?.providerReadiness?.oanda_practice);

  const items: CheckItem[] = [
    {
      id: "infra-pg",
      label: "Postgres",
      status: health?.postgres === "up" ? "ok" : "warn",
      detail: health?.postgres === "up" ? "API health reports postgres up." : "Postgres not confirmed up — see RUNBOOKS local bring-up.",
      code: health?.postgres ?? "unknown",
    },
    {
      id: "infra-redis",
      label: "Redis",
      status: health?.redis === "up" ? "ok" : health?.redis === "unknown" ? "info" : "warn",
      detail:
        health?.redis === "up"
          ? "Redis reachable."
          : "Redis may be unknown on snapshot health — queues still need REDIS_URL (see RUNBOOKS).",
      code: health?.redis ?? "unknown",
    },
    {
      id: "socket",
      label: "Terminal transport",
      status: socketState === "connected" ? "ok" : "warn",
      detail: `Socket ${socketState} — transport only; not market LIVE.`,
      code: socketState,
    },
    {
      id: "engine",
      label: "Engine",
      status: snapshot.engine.status === "RUNNING" || snapshot.engine.status === "PAUSED" ? "ok" : "info",
      detail: `Status ${snapshot.engine.status}. Start from command bar when ready for paper cycles.`,
      code: snapshot.engine.status,
    },
    {
      id: "env",
      label: "Trading environment",
      status: exec?.tradingEnvironment === "FIXTURE" ? "warn" : "ok",
      detail:
        exec?.tradingEnvironment === "FIXTURE"
          ? "FIXTURE is isolated demo — not MARKET_DATA_PAPER."
          : `Environment ${exec?.tradingEnvironment ?? "MARKET_DATA_PAPER"} · venue ${snapshot.venue ?? "PAPER"}.`,
      code: exec?.tradingEnvironment ?? "MARKET_DATA_PAPER",
    },
    {
      id: "alpaca",
      label: "Alpaca paper",
      status: alpaca.status,
      detail: alpaca.detail,
      code: alpaca.code,
    },
    {
      id: "oanda",
      label: "OANDA practice",
      status: oanda.status,
      detail: oanda.detail,
      code: oanda.code,
    },
    {
      id: "risk",
      label: "Risk / safety",
      status:
        ops?.circuitBreakerOpen || ops?.entriesSuspended || (ops?.unresolvedProtection ?? 0) > 0
          ? "blocked"
          : "ok",
      detail: ops?.circuitBreakerOpen
        ? "Circuit breaker OPEN — entries blocked until cleared by reconcile, not alert ACK."
        : ops?.entriesSuspended
          ? "Entries suspended via safety state."
          : (ops?.unresolvedProtection ?? 0) > 0
            ? `${ops?.unresolvedProtection} unresolved protection intent(s).`
            : "No open breaker / suspension flagged on ops controls.",
      code: ops?.circuitBreakerOpen ? "BREAKER_OPEN" : ops?.entriesSuspended ? "ENTRIES_SUSPENDED" : "CLEAR",
    },
  ];

  return (
    <Panel
      title={compact ? "Session readiness" : "First-session readiness"}
      extra="checklist · not a wizard"
      className={compact ? undefined : "lg:col-span-2"}
    >
      <ul className="divide-y divide-border/70">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-2.5 text-xs">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{item.label}</div>
              <p className="mt-0.5 text-[11px] text-muted">{item.detail}</p>
            </div>
            <div className="text-right">
              <span className={cn("mono text-[11px] font-medium", tone(item.status))}>
                {statusWord(item.status)}
                {item.code ? ` · ${item.code}` : ""}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <p className="border-t border-border px-4 py-3 text-[11px] text-muted">
        Honest labels: <span className="mono">MISSING_CREDENTIALS</span> means keys are absent;{" "}
        <span className="mono">NOT_IMPLEMENTED</span> means the venue path is not built — do not confuse the two. Owner
        steps:{" "}
        <Link
          href="/terminal/settings"
          className="text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          Settings
        </Link>{" "}
        · docs/launch/RUNBOOKS.md (local bring-up, practice providers, single-operator scope).
      </p>
    </Panel>
  );
}
