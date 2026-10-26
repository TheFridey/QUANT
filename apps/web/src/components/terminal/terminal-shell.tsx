"use client";

import { CommandShell } from "@/components/terminal/command-shell";

/** @deprecated Use CommandShell — retained for import compatibility. */
export function TerminalShell() {
  return <CommandShell section="overview" />;
}
