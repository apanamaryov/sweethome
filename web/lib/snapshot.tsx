"use client";

import { createContext, useContext, useEffect, useRef, useState, ReactNode } from "react";
import type { Snapshot } from "@inverter/shared";
import { wsUrl, redirectToLogin } from "./api";

interface SnapshotState {
  snapshot: Snapshot | null;
  stale: boolean;
}

const Ctx = createContext<SnapshotState>({ snapshot: null, stale: false });

export function SnapshotProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [stale, setStale] = useState(false);
  const staleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = 1000;

    const gotSnapshot = (snap: Snapshot) => {
      setSnapshot(snap);
      setStale(false);
      if (staleTimer.current) clearTimeout(staleTimer.current);
      staleTimer.current = setTimeout(() => setStale(true), 15000);
    };

    // Первый снапшот — по HTTP, чтобы не ждать первого пуша.
    fetch("/api/snapshot")
      .then(async (r) => {
        if (r.status === 401) return redirectToLogin();
        if (r.ok) gotSnapshot(await r.json());
      })
      .catch(() => {});

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        reconnectDelay = 1000;
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "snapshot") gotSnapshot(msg.data);
        } catch {}
      };
      ws.onclose = (ev) => {
        if (closed) return;
        if (ev.code === 4401) return redirectToLogin(); // сессия истекла/отозвана
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (staleTimer.current) clearTimeout(staleTimer.current);
      ws?.close();
    };
  }, []);

  // Ghosting при потере связи: CSS завязан на body.stale — оставляем как есть.
  useEffect(() => {
    document.body.classList.toggle("stale", stale);
    return () => document.body.classList.remove("stale");
  }, [stale]);

  return <Ctx.Provider value={{ snapshot, stale }}>{children}</Ctx.Provider>;
}

export function useSnapshot(): SnapshotState {
  return useContext(Ctx);
}
