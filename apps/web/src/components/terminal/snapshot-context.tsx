"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import { api, apiBase, token } from "@/lib/api";
import type { Snapshot } from "@/lib/types";

type SnapshotContextValue = {
  snapshot: Snapshot | null;
  loading: boolean;
  error: string | null;
  socketState: "connecting" | "live" | "down";
  refreshMs: number;
  setRefreshMs: (ms: number) => void;
  refresh: () => Promise<void>;
  control: (path: string, body?: unknown) => Promise<void>;
};

const SnapshotContext = createContext<SnapshotContextValue | null>(null);

export function SnapshotProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [socketState, setSocketState] = useState<"connecting" | "live" | "down">("connecting");
  const [refreshMs, setRefreshMs] = useState(5000);

  const refresh = useCallback(async () => {
    const next = await api<Snapshot>("/terminal/snapshot");
    setSnapshot(next);
    setError(null);
  }, []);

  useEffect(() => {
    if (!token()) {
      router.replace("/login");
      return;
    }
    let stop = false;
    refresh()
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Snapshot failed"))
      .finally(() => setLoading(false));
    const poll = window.setInterval(() => {
      if (!stop) void refresh().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Snapshot failed"));
    }, refreshMs);
    let socket: Socket | null = null;
    const session = token();
    if (session) {
      socket = io(apiBase(), { auth: { token: session }, transports: ["websocket"] });
      socket.on("connect", () => setSocketState("live"));
      socket.on("disconnect", () => setSocketState("down"));
      socket.on("terminal", () => void refresh().catch(() => undefined));
    }
    return () => {
      stop = true;
      window.clearInterval(poll);
      socket?.close();
    };
  }, [refresh, refreshMs, router]);

  const control = useCallback(
    async (path: string, body?: unknown) => {
      await api(path, { method: "POST", body: body ? JSON.stringify(body) : "{}" });
      await refresh();
    },
    [refresh],
  );

  const value = useMemo(
    () => ({ snapshot, loading, error, socketState, refreshMs, setRefreshMs, refresh, control }),
    [snapshot, loading, error, socketState, refreshMs, refresh, control],
  );

  return <SnapshotContext.Provider value={value}>{children}</SnapshotContext.Provider>;
}

export function useSnapshot() {
  const ctx = useContext(SnapshotContext);
  if (!ctx) throw new Error("useSnapshot requires SnapshotProvider");
  return ctx;
}
