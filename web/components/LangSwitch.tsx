"use client";

import { useI18n } from "@/lib/i18n";
import { LANGS, Lang } from "@/lib/i18n/dict";

const LABELS: Record<Lang, string> = { uk: "UA", ru: "RU", en: "EN" };

export function LangSwitch() {
  const { lang, setLang } = useI18n();
  return (
    <nav className="lang-switch" aria-label="Language">
      {LANGS.map((l) => (
        <button key={l} className={l === lang ? "active" : ""} onClick={() => setLang(l)}>
          {LABELS[l]}
        </button>
      ))}
    </nav>
  );
}
