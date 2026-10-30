import type { ReactNode } from "react";
import { SnapshotProvider } from "@/components/terminal/snapshot-context";

/**
 * UI item 15: the snapshot provider lives in the /terminal layout, which Next keeps mounted across
 * section changes, so navigating between sections reuses the snapshot and socket instead of
 * refetching from scratch.
 */
export default function TerminalLayout({ children }: { children: ReactNode }) {
  return <SnapshotProvider>{children}</SnapshotProvider>;
}
