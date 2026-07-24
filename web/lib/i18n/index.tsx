"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { DICTS, Dict, Lang, LANGS } from "./dict";

interface I18nCtx {
  lang: Lang;
  dict: Dict;
  setLang: (l: Lang) => void;
}

const Ctx = createContext<I18nCtx>({ lang: "uk", dict: DICTS.uk, setLang: () => {} });

export function LangProvider({ children }: { children: ReactNode }) {
  // Стартуем всегда с uk (совпадает с SSG-пререндером), реальный выбор
  // подхватываем из localStorage после маунта — иначе hydration mismatch.
  const [lang, setLangState] = useState<Lang>("uk");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("lang");
      if (saved && (LANGS as readonly string[]).includes(saved)) setLangState(saved as Lang);
    } catch {}
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = (l: Lang) => {
    try {
      localStorage.setItem("lang", l);
    } catch {}
    setLangState(l); // ре-рендер вместо перезагрузки страницы
  };

  return <Ctx.Provider value={{ lang, dict: DICTS[lang], setLang }}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  return useContext(Ctx);
}

export function useT(): Dict {
  return useContext(Ctx).dict;
}

/** Заголовок вкладки, следит за сменой языка. */
export function useDocTitle(key: "title" | "loginTitle" | "changePwTitle") {
  const dict = useT();
  useEffect(() => {
    document.title = dict[key];
  }, [dict, key]);
}

export function modeLabel(dict: Dict, mode: string): string {
  const v = dict[("mode" + mode) as keyof Dict];
  return typeof v === "string" ? v : mode;
}

export function warnLabel(dict: Dict, name: string): string {
  return dict.warnings[name] || name;
}

export function flagLabel(dict: Dict, key: string, fallback?: string): string {
  return dict.flags[key] || fallback || dict.flagFallback + key;
}
