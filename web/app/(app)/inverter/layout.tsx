"use client";

import { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSnapshot } from "@/lib/snapshot";
import { MetaProvider, useMeta } from "@/lib/meta";
import { useT, useDocTitle, modeLabel, warnLabel } from "@/lib/i18n";

function TopBar() {
  const t = useT();
  const { snapshot } = useSnapshot();
  const c = snapshot?.connection;

  let pillClass = "pill pill-muted";
  let pillText: string = t.connecting;
  if (c) {
    if (c.mock) {
      pillClass = "pill pill-mock";
      pillText = t.demoData;
    } else if (c.connected) {
      pillClass = "pill pill-ok";
      pillText = t.connectedVia + c.transport + (c.device ? " " + c.device : "");
    } else {
      pillClass = "pill pill-bad";
      pillText = t.noConnection;
    }
  }
  // Бейдж показывает выведенный источник питания, а не сырой режим: у инвертора
  // нет режима «от солнца», его считает сервер (shared/src/source.ts).
  // Промежуточный фолбэк на mode — на случай снапшота без powerSource (сервер
  // постарее или вкладка, оставленная открытой через деплой): payload никто не
  // валидирует, так что деградируем в прежнее поведение бейджа, а не в пустое «—».
  const source = snapshot?.powerSource ?? snapshot?.mode ?? "Unknown";

  return (
    <header className="topbar">
      <div className="topbar-row">
        <h1>{t.h1}</h1>
        <span className={"mode-badge mode-" + source}>{modeLabel(t, source)}</span>
      </div>
      <div className="topbar-row">
        <span className={pillClass}>{pillText}</span>
        {snapshot?.timestamp ? (
          // key = timestamp: ремоунт перезапускает CSS-анимацию «e-ink вспышки»
          <span key={snapshot.timestamp} className="updated flash">
            {t.updated + new Date(snapshot.timestamp).toLocaleTimeString(t.langLocale)}
          </span>
        ) : (
          <span className="updated">—</span>
        )}
      </div>
    </header>
  );
}

function WarningsBanner() {
  const t = useT();
  const { snapshot } = useSnapshot();
  const warns = snapshot?.warnings?.active ?? [];
  if (!warns.length) return null;
  return <div className="banner">{"⚠ " + warns.map((w) => warnLabel(t, w)).join(" · ")}</div>;
}

function NavTabs() {
  const t = useT();
  const meta = useMeta();
  const pathname = usePathname();
  const isAdmin = meta?.session.role === "admin";

  // Клиентский guard на admin-вкладки внутри секции инвертора теперь в SystemNav
  // (web/app/(app)/layout.tsx) — он покрывает и /users, и эти пути одним местом.

  const tabs = [
    { href: "/inverter", label: t.navDashboard, admin: false },
    { href: "/inverter/stats", label: t.navStats, admin: false },
    { href: "/inverter/settings", label: t.navSettings, admin: true },
    { href: "/inverter/diagnostics", label: t.navDiagnostics, admin: true },
  ].filter((tab) => !tab.admin || isAdmin);

  return (
    <nav className="nav-tabs">
      {tabs.map((tab) => (
        <Link key={tab.href} href={tab.href} className={pathname === tab.href ? "active" : ""}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

function Chrome({ children }: { children: ReactNode }) {
  useDocTitle("title");
  return (
    <>
      <TopBar />
      <WarningsBanner />
      <NavTabs />
      {children}
    </>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <MetaProvider>
      <Chrome>{children}</Chrome>
    </MetaProvider>
  );
}
