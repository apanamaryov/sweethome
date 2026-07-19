"use client";

import { createContext, useCallback, useContext, useRef, useState, ReactNode } from "react";

type ToastKind = "ok" | "bad" | "";

interface ToastCtx {
  toast: (msg: string, kind?: ToastKind) => void;
}

const Ctx = createContext<ToastCtx>({ toast: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ msg: string; kind: ToastKind } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = useCallback((msg: string, kind: ToastKind = "") => {
    setState({ msg, kind });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(null), 3200);
  }, []);

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      {state && <div className={"toast " + state.kind}>{state.msg}</div>}
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  return useContext(Ctx);
}
