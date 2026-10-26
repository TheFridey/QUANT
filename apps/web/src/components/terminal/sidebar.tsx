"use client";

import Link from "next/link";
import { SECTIONS } from "@/lib/sections";
import type { TerminalSection } from "@/lib/types";
import { cn } from "@/lib/utils";

export function Sidebar({ active }: { active: TerminalSection }) {
  const groups = [...new Set(SECTIONS.map((section) => section.group))];
  return (
    <aside className="panel hidden w-[220px] shrink-0 flex-col border-r border-border md:flex">
      <div className="border-b border-border px-3 py-3">
        <div className="text-[10px] uppercase tracking-[0.16em] text-muted">Navigation</div>
        <div className="mt-1 text-sm">Desk modules</div>
      </div>
      <nav className="flex-1 overflow-auto scroll-thin p-2">
        {groups.map((group) => (
          <div key={group} className="mb-3">
            <div className="px-2 pb-1 text-[10px] uppercase tracking-[0.14em] text-muted">{group}</div>
            <ul className="space-y-0.5">
              {SECTIONS.filter((section) => section.group === group).map((section) => {
                const href = section.id === "overview" ? "/terminal" : `/terminal/${section.id}`;
                const isActive = active === section.id;
                return (
                  <li key={section.id}>
                    <Link
                      href={href}
                      className={cn(
                        "block rounded px-2 py-1.5 text-[13px] transition-colors",
                        isActive ? "bg-white/5 text-foreground" : "text-muted hover:bg-white/[0.03] hover:text-foreground",
                      )}
                    >
                      {section.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}

export function MobileNav({ active }: { active: TerminalSection }) {
  return (
    <div className="border-b border-border md:hidden">
      <div className="flex gap-1 overflow-x-auto scroll-thin px-2 py-2">
        {SECTIONS.map((section) => {
          const href = section.id === "overview" ? "/terminal" : `/terminal/${section.id}`;
          return (
            <Link
              key={section.id}
              href={href}
              className={cn(
                "shrink-0 rounded border px-2 py-1 text-[11px]",
                active === section.id ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted",
              )}
            >
              {section.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
