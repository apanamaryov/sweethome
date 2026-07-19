"use client";

import { FormEvent, useState } from "react";
import { useT, useDocTitle } from "@/lib/i18n";
import { LangSwitch } from "@/components/LangSwitch";

export default function LoginPage() {
  const t = useT();
  useDocTitle("loginTitle");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // Голый fetch: 401 здесь означает «неверный пароль», а не «нет сессии».
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const data = await res.json();
      if (data.ok) {
        window.location.href = "/";
        return;
      }
      let msg: string = data.error || t.toastError;
      if (data.code === "bad_password") msg = t.badPassword;
      else if (data.code === "rate_limited") msg = t.tooMany.replace("{m}", String(data.minutes ?? "?"));
      setErr(msg);
    } catch (ex) {
      setErr(t.toastNetErr + (ex as Error).message);
    }
  };

  return (
    <div className="login-wrap">
      <div className="modal-box login-box">
        <h1 className="login-title">{t.h1}</h1>
        <p className="note">{t.loginNote}</p>
        <form className="row" onSubmit={submit}>
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder={t.loginPassword}
            autoComplete="current-password"
            autoFocus
          />
          <button className="apply" type="submit">
            {t.loginSubmit}
          </button>
        </form>
        {err && <p className="login-err">{err}</p>}
        <LangSwitch />
      </div>
    </div>
  );
}
