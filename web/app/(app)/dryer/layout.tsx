"use client";

import { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { DryerProvider } from "@/lib/dryer-state";
import { useSession } from "@/lib/session";
import { useT } from "@/lib/i18n";

function Tabs() {
  const t = useT();
  const pathname = usePathname();
  const isAdmin = useSession()?.role === "admin";
  const tabs = [
    { href: "/dryer", label: t.navDryer },
    { href: "/dryer/history", label: t.dryerTabHistory },
    ...(isAdmin ? [{ href: "/dryer/settings", label: t.dryerTabSettings }] : []),
  ];
  return (
    <nav className="nav-tabs">
      {tabs.map((tab) => (
        <Link key={tab.href} href={tab.href} className={pathname === tab.href ? "active" : ""}>{tab.label}</Link>
      ))}
    </nav>
  );
}

export default function DryerLayout({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <DryerProvider>
      <header className="topbar"><div className="topbar-row"><h1>{t.navDryer}</h1></div></header>
      <Tabs />
      {children}
    </DryerProvider>
  );
}
