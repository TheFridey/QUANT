"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  NAV_GROUPS,
  SECTIONS,
  groupForSection,
  sectionHref,
  sectionsInGroup,
  type NavGroup,
} from "@/lib/sections";
import type { TerminalSection } from "@/lib/types";
import { cn } from "@/lib/utils";

export function Sidebar({ active }: { active: TerminalSection }) {
  return (
    <aside className="panel hidden w-[220px] shrink-0 flex-col border-r border-border md:flex">
      <div className="border-b border-border px-3 py-3">
        <div className="text-[10px] uppercase tracking-[0.16em] text-muted">Navigation</div>
        <div className="mt-1 text-sm">Desk modules</div>
      </div>
      <nav className="flex-1 overflow-auto scroll-thin p-2" aria-label="Primary">
        {NAV_GROUPS.map((group) => (
          <div key={group} className="mb-3">
            <div className="px-2 pb-1 text-[10px] uppercase tracking-[0.14em] text-muted">{group}</div>
            <ul className="space-y-0.5">
              {sectionsInGroup(group).map((section) => {
                const isActive = active === section.id;
                return (
                  <li key={section.id}>
                    <Link
                      href={sectionHref(section.id)}
                      className={cn(
                        "block rounded px-2 py-1.5 text-[13px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                        isActive ? "bg-white/5 text-foreground" : "text-muted hover:bg-white/[0.03] hover:text-foreground",
                      )}
                      aria-current={isActive ? "page" : undefined}
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

const MOBILE_GROUP_LABEL: Partial<Record<NavGroup, string>> = { "Orders & Positions": "Orders" };

export function MobileNav({ active }: { active: TerminalSection }) {
  const activeGroup = groupForSection(active);
  const [openGroup, setOpenGroup] = useState<NavGroup>(activeGroup);
  const modules = useMemo(() => sectionsInGroup(openGroup), [openGroup]);

  useEffect(() => {
    setOpenGroup(activeGroup);
  }, [activeGroup]);

  return (
    <div className="border-b border-border md:hidden">
      {/* UI item 14: wrap the group strip instead of clipping labels off-screen. */}
      <div className="flex flex-wrap gap-1 px-2 pt-2" role="tablist" aria-label="Nav groups">
        {NAV_GROUPS.map((group) => {
          const selected = openGroup === group;
          const containsActive = groupForSection(active) === group;
          return (
            <button
              key={group}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setOpenGroup(group)}
              className={cn(
                "shrink-0 rounded border px-2.5 py-1.5 text-[11px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                selected
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : containsActive
                    ? "border-border text-foreground"
                    : "border-border text-muted",
              )}
            >
              {MOBILE_GROUP_LABEL[group] ?? group}
            </button>
          );
        })}
      </div>
      <div className="flex gap-1 overflow-x-auto scroll-thin px-2 py-2" role="tabpanel" aria-label={`${openGroup} modules`}>
        {modules.map((section) => {
          const isActive = active === section.id;
          return (
            <Link
              key={section.id}
              href={sectionHref(section.id)}
              className={cn(
                "shrink-0 rounded border px-2 py-1 text-[11px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                isActive ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted",
              )}
              aria-current={isActive ? "page" : undefined}
            >
              {section.shortLabel ?? section.label}
            </Link>
          );
        })}
      </div>
      <p className="sr-only">
        {SECTIONS.length} modules across {NAV_GROUPS.length} groups. Active: {active}.
      </p>
    </div>
  );
}
