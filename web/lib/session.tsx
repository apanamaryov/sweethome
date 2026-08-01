"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import type { SessionUser } from "@sweethome/inverter-shared";
import { getJson } from "./api";

const Ctx = createContext<SessionUser | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionUser | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Тот же паттерн ретраев, что у MetaProvider: демон временно недоступен —
    // страница живёт, сессия подгружается фоном.
    const load = async () => {
      try {
        const s = await getJson<SessionUser>("/api/me");
        if (!cancelled) setSession(s);
      } catch (e) {
        // getJson уже само увело на /login при 401 (см. redirectToLogin внутри) —
        // повторять запрос дальше незачем. (/api/me остаётся доступным даже при
        // must_change_password, так что 403-ветка getJson тут не срабатывает.)
        if ((e as Error).message === "Unauthorized") return;
        if (!cancelled) timer = setTimeout(load, 5000);
      }
    };
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return <Ctx.Provider value={session}>{children}</Ctx.Provider>;
}

export function useSession(): SessionUser | null {
  return useContext(Ctx);
}
