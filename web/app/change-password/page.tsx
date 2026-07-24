"use client";

import { FormEvent, useState } from "react";
import { useT, useDocTitle } from "@/lib/i18n";
import { LangSwitch } from "@/components/LangSwitch";

export default function ChangePasswordPage() {
  const t = useT();
  useDocTitle("changePwTitle");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (next.length < 6) {
      setErr(t.changePwMismatch);
      return;
    }
    try {
      const res = await fetch("/api/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = await res.json();
      if (data.ok) {
        window.location.href = "/";
        return;
      }
      setErr(data.error || t.toastError);
    } catch (ex) {
      setErr(t.toastNetErr + (ex as Error).message);
    }
  };

  return (
    <div className="login-wrap">
      <div className="modal-box login-box">
        <h1 className="login-title">{t.changePwTitle}</h1>
        <p className="note">{t.changePwNote}</p>
        <form className="row" onSubmit={submit}>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            placeholder={t.changePwCurrent}
            autoComplete="current-password"
            autoFocus
          />
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder={t.changePwNew}
            autoComplete="new-password"
          />
          <button className="apply" type="submit">
            {t.changePwSubmit}
          </button>
        </form>
        {err && <p className="login-err">{err}</p>}
        <LangSwitch />
      </div>
    </div>
  );
}
