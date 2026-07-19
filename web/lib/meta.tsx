"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import type { ApiMeta } from "@inverter/shared";
import { redirectToLogin } from "./api";

const Ctx = createContext<ApiMeta | null>(null);

export function MetaProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<ApiMeta | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Если демон временно недоступен — страница живёт, meta ретраится фоном
    // (перенос поведения trySetupControls из старого app.js).
    const load = async () => {
      try {
        const res = await fetch("/api/meta");
        if (res.status === 401) return redirectToLogin();
        if (!res.ok) throw new Error(String(res.status));
        const m = (await res.json()) as ApiMeta;
        if (!cancelled) setMeta(m);
      } catch {
        if (!cancelled) timer = setTimeout(load, 5000);
      }
    };
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return <Ctx.Provider value={meta}>{children}</Ctx.Provider>;
}

export function useMeta(): ApiMeta | null {
  return useContext(Ctx);
}
