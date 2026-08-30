"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from "react";
import type { DryerSnapshot } from "@sweethome/dryer-shared";
import { redirectToLogin, wsUrl } from "./api";
import { fetchDryerState } from "./dryer";

interface DryerState {
  snapshot: DryerSnapshot | null;
  error: string | null;
  refresh(): void;
}

const Ctx = createContext<DryerState>({ snapshot: null, error: null, refresh: () => {} });

const POLL_MS = 10_000;

/**
 * Снапшот сушилки: первый — по HTTP, дальше по WS (/ws/dryer шлёт тот же объект без обёртки);
 * пока сокет не открыт — опрос GET /state раз в 10 с (спека §8). Один провайдер на раздел.
 */
export function DryerProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<DryerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsOpen = useRef(false);

  const refresh = useCallback(() => {
    fetchDryerState()
      .then((s) => {
        setSnapshot(s);
        setError(null);
      })
      .catch((e: Error) => {
        if (e.message !== "Unauthorized") setError(e.message);
      });
  }, []);

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let delay = 1000;
    refresh();
    const poll = setInterval(() => {
      if (!wsOpen.current) refresh();
    }, POLL_MS);

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(wsUrl("dryer"));
      ws.onopen = () => {
        wsOpen.current = true;
        delay = 1000;
      };
      ws.onmessage = (ev) => {
        try {
          setSnapshot(JSON.parse(ev.data) as DryerSnapshot);
          setError(null);
        } catch {}
      };
      ws.onclose = (ev) => {
        wsOpen.current = false;
        if (closed) return;
        if (ev.code === 4401) return redirectToLogin();
        reconnect = setTimeout(connect, delay);
        delay = Math.min(delay * 1.5, 10_000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      closed = true;
      clearInterval(poll);
      if (reconnect) clearTimeout(reconnect);
      ws?.close();
    };
  }, [refresh]);

  return <Ctx.Provider value={{ snapshot, error, refresh }}>{children}</Ctx.Provider>;
}

export function useDryer(): DryerState {
  return useContext(Ctx);
}
