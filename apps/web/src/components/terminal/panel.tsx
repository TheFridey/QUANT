import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Panel({
  title,
  extra,
  className,
  bodyClassName,
  children,
}: {
  title?: string;
  extra?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("panel flex min-h-0 flex-col overflow-hidden rounded-md", className)}>
      {title ? (
        <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">{title}</h2>
          {extra ? <div className="text-[11px] text-muted">{extra}</div> : null}
        </header>
      ) : null}
      <div className={cn("min-h-0 flex-1 overflow-auto scroll-thin", bodyClassName)}>{children}</div>
    </section>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="grid h-full min-h-[120px] place-items-center px-4 py-8 text-center">
      <div>
        <p className="text-sm text-foreground/90">{title}</p>
        {detail ? <p className="mt-1 text-xs text-muted">{detail}</p> : null}
      </div>
    </div>
  );
}

export function Metric({
  label,
  value,
  hint,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  valueClassName?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className={cn("mt-1 truncate text-sm", valueClassName)}>{value}</div>
      {hint ? <div className="mt-0.5 text-[10px] text-muted">{hint}</div> : null}
    </div>
  );
}

export function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded", className)} />;
}
