"use client";

import { useCallback, useEffect, useState } from "react";
import type { PublicApiToken, TokenScope } from "@sweethome/inverter-shared";
import { getJson, postJson } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useToast } from "@/lib/toast";

/** Секция управления API-токенами на странице /users (только admin). */
export function TokensPanel() {
  const t = useT();
  const { toast } = useToast();
  const [tokens, setTokens] = useState<PublicApiToken[]>([]);
  const [name, setName] = useState("");
  const [write, setWrite] = useState(false);
  const [days, setDays] = useState("");
  const [issued, setIssued] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setTokens(await getJson<PublicApiToken[]>("/api/tokens"));
    } catch (e) {
      toast((e as Error).message);
    }
  }, [toast]);

  useEffect(() => {
    reload();
  }, [reload]);

  const create = async () => {
    try {
      const scopes: TokenScope[] = write ? ["read", "write"] : ["read"];
      const body: { name: string; scopes: TokenScope[]; expiresInDays?: number } = { name, scopes };
      if (days.trim()) body.expiresInDays = Number(days);
      const data = await (await postJson("/api/tokens", body)).json();
      if (!data.ok) return toast(data.error || t.toastError);
      setIssued(data.token);
      setName("");
      setDays("");
      setWrite(false);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const revoke = async (tok: PublicApiToken) => {
    if (!window.confirm(t.tokensConfirmRevoke + " " + tok.name)) return;
    try {
      const res = await fetch(`/api/tokens/${tok.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) return toast(data.error || t.toastError);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const stamp = (ms: number | null, fallback: string) =>
    ms === null ? fallback : new Date(ms).toLocaleString(t.langLocale);

  return (
    <section className="card">
      <div className="card-head">
        <span className="card-title">{t.tokensTitle}</span>
      </div>

      {issued ? (
        <div className="token-issued">
          <p className="note">{t.tokensCopyHint}</p>
          <code>{issued}</code>
        </div>
      ) : null}

      <div className="tokens-list">
        {tokens.length === 0 ? (
          <p className="note">{t.tokensEmpty}</p>
        ) : (
          tokens.map((tok) => (
            <div className="token-card" key={tok.id}>
              <div className="token-card-head">
                <span className="token-name">{tok.name}</span>
                <code className="token-prefix">{tok.prefix}</code>
              </div>
              <div className="token-meta">
                <span>{tok.scopes.includes("write") ? t.tokensScopeWrite : t.tokensScopeRead}</span>
                <span>
                  {t.tokensCreated}: {stamp(tok.createdAt, "—")}
                </span>
                <span>
                  {t.tokensLastUsed}: {stamp(tok.lastUsedAt, t.tokensNeverUsed)}
                </span>
                <span>
                  {t.tokensExpires}: {stamp(tok.expiresAt, t.tokensNever)}
                </span>
              </div>
              <div className="token-card-actions">
                <button className="btn-danger" onClick={() => revoke(tok)}>
                  {t.tokensRevoke}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="tokens-add">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.tokensName} />
        <input
          value={days}
          onChange={(e) => setDays(e.target.value)}
          placeholder={t.tokensDays}
          inputMode="numeric"
        />
        <label className="token-scope">
          <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />
          <span>{t.tokensScopeWrite}</span>
        </label>
        <button className="apply" onClick={create}>
          {t.tokensAdd}
        </button>
      </div>
    </section>
  );
}
