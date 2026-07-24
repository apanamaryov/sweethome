"use client";

import { useCallback, useEffect, useState } from "react";
import type { PublicUser, Role } from "@inverter/shared";
import { getJson, postJson } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useToast } from "@/lib/toast";

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
      <section className="panel">
        <h2>{t.usersTitle}</h2>
        <div className="table-scroll">
          <table className="users-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t.loginUsername}</th>
                <th>{t.usersRole}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.id}</td>
                  <td>
                    {u.username}
                    {u.mustChangePassword ? <span className="note"> ({t.usersMustChange})</span> : null}
                  </td>
                  <td>
                    <select value={u.role} onChange={(e) => changeRole(u, e.target.value as Role)}>
                      <option value="admin">{t.usersRoleAdmin}</option>
                      <option value="viewer">{t.usersRoleViewer}</option>
                    </select>
                  </td>
                  <td className="users-actions">
                    <button className="btn-ghost" onClick={() => resetPw(u)}>{t.usersResetPw}</button>
                    <button className="btn-danger" onClick={() => del(u)}>{t.usersDelete}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>{t.usersAdd}</h2>
        <div className="row users-add">
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
    </main>
  );
}
