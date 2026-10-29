"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import { api, apiBase, token } from "@/lib/api";
import type { Snapshot } from "@/lib/types";

type SocketState = "connecting" | "connected" | "down" | "error";

type SnapshotContextValue = {
  snapshot: Snapshot | null;
  loading: boolean;
  error: string | null;
  /** Terminal Socket.IO transport only — not market freshness (D18). */
  socketState: SocketState;
  lastRefreshAt: string | null;
  refreshMs: number;
  setRefreshMs: (ms: number) => void;
  refresh: () => Promise<void>;
  control: (path: string, body?: unknown) => Promise<void>;
};

const SnapshotContext = createContext<SnapshotContextValue | null>(null);
const REFRESH_MS_KEY = "odin.terminal.refreshMs";

function readPersistedRefreshMs(): number {
  if (typeof window === "undefined") return 5000;
  try {
    const raw = window.localStorage.getItem(REFRESH_MS_KEY);
    const parsed = raw ? Number(raw) : 5000;
    if ([2000, 5000, 10000, 30000].includes(parsed)) return parsed;
  } catch {
    /* ignore */
  }
  return 5000;
}

export function SnapshotProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [socketState, setSocketState] = useState<SocketState>("connecting");
  const [refreshMs, setRefreshMsState] = useState(5000);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const revisionRef = useRef(0);
  const inflightRef = useRef<AbortController | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);

  useEffect(() => {
    setRefreshMsState(readPersistedRefreshMs());
  }, []);

  const setRefreshMs = useCallback((ms: number) => {
    setRefreshMsState(ms);
    try {
      window.localStorage.setItem(REFRESH_MS_KEY, String(ms));
    } catch {
      /* ignore */
    }
  }, []);

  const refresh = useCallback(async () => {
    const revision = ++revisionRef.current;
    inflightRef.current?.abort();
    const controller = new AbortController();
    inflightRef.current = controller;
    try {
      const next = await api<Snapshot>("/terminal/snapshot", { signal: controller.signal });
      if (revision !== revisionRef.current) return;
      snapshotRef.current = next;
      setSnapshot(next);
      setLastRefreshAt(new Date().toISOString());
      setError(null);
    } catch (caught) {
      if (controller.signal.aborted || revision !== revisionRef.current) return;
      setError(caught instanceof Error ? caught.message : "Snapshot failed");
    }
  }, []);

  useEffect(() => {
    if (!token()) {
      router.replace("/login");
      return;
    }
    let stop = false;
    refresh()
      .catch(() => undefined)
      .finally(() => {
        if (!stop) setLoading(false);
      });

    const poll = window.setInterval(() => {
      if (stop || document.visibilityState === "hidden") return;
      void refresh();
    }, refreshMs);

    let socket: Socket | null = null;
    const session = token();
    if (session) {
      socket = io(apiBase(), { auth: { token: session }, transports: ["websocket"] });
      socket.on("connect", () => setSocketState("connected"));
      socket.on("disconnect", () => setSocketState("down"));
      socket.on("connect_error", () => setSocketState("error"));
      socket.on("terminal", () => {
        if (!stop) void refresh();
      });
    }

    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stop = true;
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      inflightRef.current?.abort();
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
    () => ({
      snapshot,
      loading,
      error,
      socketState,
      lastRefreshAt,
      refreshMs,
      setRefreshMs,
      refresh,
      control,
    }),
    [snapshot, loading, error, socketState, lastRefreshAt, refreshMs, setRefreshMs, refresh, control],
  );

  return <SnapshotContext.Provider value={value}>{children}</SnapshotContext.Provider>;
}

export function useSnapshot() {
  const ctx = useContext(SnapshotContext);
  if (!ctx) throw new Error("useSnapshot requires SnapshotProvider");
  return ctx;
}
