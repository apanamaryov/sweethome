"use client";

import { ReactNode, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SnapshotProvider } from "@/lib/snapshot";
import { SessionProvider, useSession } from "@/lib/session";
import { ToastProvider } from "@/lib/toast";
import { useT } from "@/lib/i18n";
import { LangSwitch } from "@/components/LangSwitch";

const ADMIN_PATH_PREFIXES = ["/inverter/settings", "/inverter/diagnostics", "/users", "/dryer/settings"];

function SystemNav() {
  const t = useT();
  const session = useSession();
  const pathname = usePathname();
  const isAdmin = session?.role === "admin";

  // Клиентский guard: viewer, попавший на admin-страницу, уводится на обзор
  // (сервер тоже редиректит — это подстраховка для SPA-навигации).
  useEffect(() => {
    if (!session) return;
    if (!isAdmin && ADMIN_PATH_PREFIXES.some((p) => pathname.startsWith(p))) window.location.href = "/";
  }, [session, isAdmin, pathname]);

  const sections = [
    { href: "/", label: t.navOverview, active: pathname === "/" },
    { href: "/inverter", label: t.navInverter, active: pathname.startsWith("/inverter") },
    { href: "/cctv", label: t.navCctv, active: pathname.startsWith("/cctv") },
    { href: "/dryer", label: t.navDryer, active: pathname.startsWith("/dryer") },
    ...(isAdmin ? [{ href: "/users", label: t.navUsers, active: pathname.startsWith("/users") }] : []),
  ];

  return (
    <nav className="nav-tabs nav-sections">
      {sections.map((s) => (
        <Link key={s.href} href={s.href} className={s.active ? "active" : ""}>
          {s.label}
        </Link>
      ))}
    </nav>
  );
}

function SystemFooter() {
  const t = useT();
  const session = useSession();
  const logout = async (e: React.MouseEvent) => {
    e.preventDefault();
    try {
      await fetch("/api/logout", { method: "POST" });
    } catch {}
    window.location.href = "/login";
  };
  return (
    <footer className="footer">
      <div className="footer-row">
        <span>{session ? session.username : "—"}</span>
        {session && (
          <a href="#" className="logout" onClick={logout}>
            {t.logout}
          </a>
        )}
      </div>
      <LangSwitch />
    </footer>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <SnapshotProvider>
        <ToastProvider>
          <SystemNav />
          {children}
          <SystemFooter />
        </ToastProvider>
      </SnapshotProvider>
    </SessionProvider>
  );
}
