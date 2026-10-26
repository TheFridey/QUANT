"use client";

import { use } from "react";
import { CommandShell } from "@/components/terminal/command-shell";
import { parseSection } from "@/lib/sections";

export default function TerminalSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = use(params);
  return <CommandShell section={parseSection(section)} />;
}
