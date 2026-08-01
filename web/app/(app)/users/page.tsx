"use client";

import { useCallback, useEffect, useState } from "react";
import type { PublicUser, Role } from "@sweethome/inverter-shared";
import { getJson, postJson } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useToast } from "@/lib/toast";
import { TokensPanel } from "@/components/TokensPanel";

export default function UsersPage() {
  const t = useT();
  const { toast } = useToast();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [uname, setUname] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [pw, setPw] = useState("");

  const reload = useCallback(async () => {
    try {
      setUsers(await getJson<PublicUser[]>("/api/users"));
    } catch (e) {
      toast((e as Error).message);
    }
  }, [toast]);

  useEffect(() => {
    reload();
  }, [reload]);

  const add = async () => {
    try {
      const res = await postJson("/api/users", { username: uname, role, password: pw });
      const data = await res.json();
      if (!data.ok) return toast(data.error || t.toastError);
      setUname("");
      setPw("");
      setRole("viewer");
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const changeRole = async (u: PublicUser, next: Role) => {
    if (next === u.role) return;
    try {
      const res = await fetch(`/api/users/${u.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: next }),
      });
      const data = await res.json();
      if (!data.ok) return toast(data.error || t.toastError);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const resetPw = async (u: PublicUser) => {
    const np = window.prompt(t.usersResetPw + " — " + u.username);
    if (!np) return;
    try {
      const res = await postJson(`/api/users/${u.id}/reset-password`, { newPassword: np });
      const data = await res.json();
      if (!data.ok) return toast(data.error || t.toastError);
      toast("OK");
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const del = async (u: PublicUser) => {
    if (!window.confirm(t.usersConfirmDelete + " " + u.username)) return;
    try {
      const res = await fetch(`/api/users/${u.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) return toast(data.error || t.toastError);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <main className="grid">
      <section className="card">
        <div className="card-head">
          <span className="card-title">{t.usersTitle}</span>
        </div>
        <div className="users-list">
          {users.map((u) => (
            <div className="user-card" key={u.id}>
              <div className="user-card-head">
                <span className="user-name">{u.username}</span>
                {u.mustChangePassword ? <span className="tag">{t.usersMustChange}</span> : null}
              </div>
              <label className="user-role-row">
                <span className="user-role-label">{t.usersRole}</span>
                <select value={u.role} onChange={(e) => changeRole(u, e.target.value as Role)}>
                  <option value="admin">{t.usersRoleAdmin}</option>
                  <option value="viewer">{t.usersRoleViewer}</option>
                </select>
              </label>
              <div className="user-card-actions">
                <button className="btn-ghost" onClick={() => resetPw(u)}>{t.usersResetPw}</button>
                <button className="btn-danger" onClick={() => del(u)}>{t.usersDelete}</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <span className="card-title">{t.usersAdd}</span>
        </div>
        <div className="users-add">
          <input value={uname} onChange={(e) => setUname(e.target.value)} placeholder={t.loginUsername} />
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder={t.changePwNew}
            autoComplete="new-password"
          />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="admin">{t.usersRoleAdmin}</option>
            <option value="viewer">{t.usersRoleViewer}</option>
          </select>
          <button className="apply" onClick={add}>
            {t.usersAdd}
          </button>
        </div>
      </section>

      <TokensPanel />
    </main>
  );
}
