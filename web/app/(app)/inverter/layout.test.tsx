import { ReactNode } from "react";
import { act, render, screen, within } from "@testing-library/react";
import { LangProvider } from "@/lib/i18n";
import { DICTS } from "@/lib/i18n/dict";
import { SnapshotProvider } from "@/lib/snapshot";
import type { ApiMeta, Snapshot } from "@sweethome/inverter-shared";
import {
  buildMeta,
  buildSnapshot,
  flushMicrotasks,
  installFakeWebSocket,
  restoreLocation,
  setLocation,
  setMockPathname,
  wrapProviderFetch,
} from "@/test-utils/renderWithProviders";
import AppLayout from "./layout";

const t = DICTS.uk;

afterEach(() => {
  restoreLocation();
});

/**
 * AppLayout (inverter section) no longer wraps SnapshotProvider itself — that
 * now lives one level up, in the system app/(app)/layout.tsx — so the test
 * supplies its own, exactly like the real system layout would nest it.
 */
async function renderLayout(
  children: ReactNode,
  opts: { snapshot?: Snapshot | null; meta?: ApiMeta | null; pathname?: string } = {}
) {
  const { snapshot = buildSnapshot(), meta = buildMeta("admin"), pathname = "/inverter" } = opts;
  setMockPathname(pathname);
  setLocation({});
  installFakeWebSocket();
  wrapProviderFetch({ snapshot, meta });

  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(
      <LangProvider>
        <SnapshotProvider>
          <AppLayout>{children}</AppLayout>
        </SnapshotProvider>
      </LangProvider>
    );
    await flushMicrotasks();
  });
  return utils;
}

describe("AppLayout (inverter) — TopBar connection pill", () => {
  it("shows 'connecting' before any snapshot has arrived", async () => {
    await renderLayout(<div>child</div>, { snapshot: null });

    expect(screen.getByText(t.connecting)).toHaveClass("pill", "pill-muted");
  });

  it("shows the demo-data pill when connection.mock is true", async () => {
    await renderLayout(<div>child</div>, { snapshot: buildSnapshot({ connection: { connected: true, transport: "mock", device: null, deviceId: "d1", mock: true, lastError: null } }) });

    expect(screen.getByText(t.demoData)).toHaveClass("pill", "pill-mock");
  });

  it("shows the connected-via pill (with transport+device) for a real, connected inverter", async () => {
    await renderLayout(<div>child</div>, {
      snapshot: buildSnapshot({
        connection: { connected: true, transport: "serial", device: "/dev/ttyUSB0", deviceId: "d1", mock: false, lastError: null },
      }),
    });

    expect(screen.getByText(t.connectedVia + "serial /dev/ttyUSB0")).toHaveClass("pill", "pill-ok");
  });

  it("shows the no-connection pill when the inverter is unreachable", async () => {
    await renderLayout(<div>child</div>, {
      snapshot: buildSnapshot({
        connection: { connected: false, transport: "serial", device: null, deviceId: null, mock: false, lastError: "timeout" },
      }),
    });

    expect(screen.getByText(t.noConnection)).toHaveClass("pill", "pill-bad");
  });
});

describe("AppLayout (inverter) — бейдж источника питания", () => {
  it("показывает выведенный источник, а не режим инвертора", async () => {
    const snapshot = buildSnapshot({ mode: "Battery", powerSource: "Solar" });
    await renderLayout(<div>child</div>, { snapshot });

    const badge = screen.getByText(t.modeSolar);
    expect(badge).toHaveClass("mode-badge", "mode-Solar");
    expect(screen.queryByText(t.modeBattery)).not.toBeInTheDocument();
  });

  it("показывает режим как есть, когда солнце не выведено", async () => {
    const snapshot = buildSnapshot({ mode: "Battery", powerSource: "Battery" });
    await renderLayout(<div>child</div>, { snapshot });

    expect(screen.getByText(t.modeBattery)).toHaveClass("mode-badge", "mode-Battery");
  });

  it("падает обратно на режим, когда в снапшоте нет powerSource", async () => {
    // Старый сервер (или клиент, оставленный открытым через деплой) присылает
    // снапшот без powerSource — валидации payload'а нет, так что деградировать
    // надо в прежнее поведение бейджа, а не в пустое "—".
    const legacy = buildSnapshot({ mode: "Line" });
    delete (legacy as { powerSource?: unknown }).powerSource;
    await renderLayout(<div>child</div>, { snapshot: legacy });

    expect(screen.getByText(t.modeLine)).toHaveClass("mode-badge", "mode-Line");
  });

  it("до первого снапшота показывает Unknown", async () => {
    const { container } = await renderLayout(<div>child</div>, { snapshot: null });

    // Запрос по классу, а не по тексту: `modeUnknown` — это "—", и такой же
    // текст без снапшота стоит в спане времени обновления, поэтому
    // getByText("—") нашёл бы два элемента и упал.
    const badge = container.querySelector(".mode-badge")!;
    expect(badge).toHaveClass("mode-Unknown");
    expect(badge).toHaveTextContent(t.modeUnknown);
  });
});

describe("AppLayout (inverter) — WarningsBanner", () => {
  it("shows active warnings translated, joined with a middle dot", async () => {
    await renderLayout(<div>child</div>, {
      snapshot: buildSnapshot({ warnings: { active: ["Overload"], raw: "108=1" } }),
    });

    expect(screen.getByText("⚠ " + t.warnings["Overload"])).toBeInTheDocument();
  });

  it("renders nothing when there are no active warnings", async () => {
    const { container } = await renderLayout(<div>child</div>, {
      snapshot: buildSnapshot({ warnings: { active: [], raw: "108=0" } }),
    });

    expect(container.querySelector(".banner")).not.toBeInTheDocument();
  });
});

describe("AppLayout (inverter) — NavTabs (role-based visibility)", () => {
  it("admin sees all 4 inverter tabs, including the admin-only ones", async () => {
    const { container } = await renderLayout(<div>child</div>, { meta: buildMeta("admin"), pathname: "/inverter" });

    // Scoped to .nav-tabs: the system nav (not rendered here) would add its own <nav> too.
    const nav = within(container.querySelector<HTMLElement>(".nav-tabs")!);
    expect(nav.getByText(t.navDashboard)).toBeInTheDocument();
    expect(nav.getByText(t.navStats)).toBeInTheDocument();
    expect(nav.getByText(t.navSettings)).toBeInTheDocument();
    expect(nav.getByText(t.navDiagnostics)).toBeInTheDocument();
    // /users lives in the system nav now, never inside the inverter section's own tabs.
    expect(nav.queryByText(t.navUsers)).not.toBeInTheDocument();
  });

  it("viewer only sees Dashboard + Stats (admin-only tabs hidden)", async () => {
    await renderLayout(<div>child</div>, { meta: buildMeta("viewer"), pathname: "/inverter" });

    expect(screen.getByText(t.navDashboard)).toBeInTheDocument();
    expect(screen.getByText(t.navStats)).toBeInTheDocument();
    expect(screen.queryByText(t.navSettings)).not.toBeInTheDocument();
    expect(screen.queryByText(t.navDiagnostics)).not.toBeInTheDocument();
  });

  it("tabs link under /inverter/*", async () => {
    const { container } = await renderLayout(<div>child</div>, { meta: buildMeta("admin"), pathname: "/inverter" });

    const nav = within(container.querySelector<HTMLElement>(".nav-tabs")!);
    expect(nav.getByText(t.navDashboard).closest("a")).toHaveAttribute("href", "/inverter");
    expect(nav.getByText(t.navStats).closest("a")).toHaveAttribute("href", "/inverter/stats");
    expect(nav.getByText(t.navSettings).closest("a")).toHaveAttribute("href", "/inverter/settings");
    expect(nav.getByText(t.navDiagnostics).closest("a")).toHaveAttribute("href", "/inverter/diagnostics");
  });
});

describe("AppLayout (inverter) — Chrome renders children", () => {
  it("renders the page content passed as children alongside the chrome", async () => {
    await renderLayout(<div data-testid="page-body">hello</div>);

    expect(screen.getByTestId("page-body")).toBeInTheDocument();
    expect(screen.getByText(t.h1)).toBeInTheDocument();
  });
});
