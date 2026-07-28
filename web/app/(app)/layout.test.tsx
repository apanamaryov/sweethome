import { ReactNode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LangProvider } from "@/lib/i18n";
import { DICTS } from "@/lib/i18n/dict";
import type { ApiMeta, Snapshot } from "@inverter/shared";
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

async function renderLayout(
  children: ReactNode,
  opts: { snapshot?: Snapshot | null; meta?: ApiMeta | null; pathname?: string } = {}
) {
  const { snapshot = buildSnapshot(), meta = buildMeta("admin"), pathname = "/" } = opts;
  setMockPathname(pathname);
  setLocation({});
  installFakeWebSocket();
  wrapProviderFetch({ snapshot, meta });

  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(
      <LangProvider>
        <AppLayout>{children}</AppLayout>
      </LangProvider>
    );
    await flushMicrotasks();
  });
  return utils;
}

describe("AppLayout — TopBar connection pill", () => {
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

describe("AppLayout — бейдж источника питания", () => {
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

describe("AppLayout — WarningsBanner", () => {
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

describe("AppLayout — NavTabs (role-based visibility + guard)", () => {
  it("admin sees all 5 nav tabs, including the admin-only ones", async () => {
    const { container } = await renderLayout(<div>child</div>, { meta: buildMeta("admin"), pathname: "/" });

    // Scoped to .nav-tabs: the footer also renders a <nav> (LangSwitch).
    const nav = within(container.querySelector<HTMLElement>(".nav-tabs")!);
    expect(nav.getByText(t.navDashboard)).toBeInTheDocument();
    expect(nav.getByText(t.navStats)).toBeInTheDocument();
    expect(nav.getByText(t.navSettings)).toBeInTheDocument();
    expect(nav.getByText(t.navDiagnostics)).toBeInTheDocument();
    expect(nav.getByText(t.navUsers)).toBeInTheDocument();
  });

  it("viewer only sees Dashboard + Stats (admin-only tabs hidden)", async () => {
    await renderLayout(<div>child</div>, { meta: buildMeta("viewer"), pathname: "/" });

    expect(screen.getByText(t.navDashboard)).toBeInTheDocument();
    expect(screen.getByText(t.navStats)).toBeInTheDocument();
    expect(screen.queryByText(t.navSettings)).not.toBeInTheDocument();
    expect(screen.queryByText(t.navDiagnostics)).not.toBeInTheDocument();
    expect(screen.queryByText(t.navUsers)).not.toBeInTheDocument();
  });

  it("redirects a viewer away (to /) when the current path is an admin-only page", async () => {
    await renderLayout(<div>child</div>, { meta: buildMeta("viewer"), pathname: "/settings" });

    await waitFor(() => expect(window.location.href).toBe("/"));
  });

  it("does not redirect an admin on the same admin-only page", async () => {
    await renderLayout(<div>child</div>, { meta: buildMeta("admin"), pathname: "/settings" });

    await flushMicrotasks();
    expect(window.location.href).toBe("");
  });

  it("does not redirect a viewer on a non-admin page (dashboard)", async () => {
    await renderLayout(<div>child</div>, { meta: buildMeta("viewer"), pathname: "/" });

    await flushMicrotasks();
    expect(window.location.href).toBe("");
  });

  it.each(["/diagnostics", "/users"])("also redirects a viewer away from %s", async (path) => {
    await renderLayout(<div>child</div>, { meta: buildMeta("viewer"), pathname: path });

    await waitFor(() => expect(window.location.href).toBe("/"));
  });
});

describe("AppLayout — Footer", () => {
  it("shows the port label and, once info is known, the rated power", async () => {
    await renderLayout(<div>child</div>, {
      snapshot: buildSnapshot({
        connection: { connected: true, transport: "serial", device: "/dev/ttyUSB0", deviceId: "d1", mock: false, lastError: null },
      }),
    });

    expect(screen.getByText(t.portLabel + "/dev/ttyUSB0" + t.ratedLabel + "5500" + t.ratedUnit)).toBeInTheDocument();
  });

  it("shows a logout link once meta has loaded, which POSTs /api/logout and redirects to /login", async () => {
    const user = userEvent.setup();
    await renderLayout(<div>child</div>);

    const logoutLink = screen.getByText(t.logout);
    await user.click(logoutLink);

    await waitFor(() => expect(window.location.href).toBe("/login"));
  });
});

describe("AppLayout — Chrome renders children", () => {
  it("renders the page content passed as children alongside the chrome", async () => {
    await renderLayout(<div data-testid="page-body">hello</div>);

    expect(screen.getByTestId("page-body")).toBeInTheDocument();
    expect(screen.getByText(t.h1)).toBeInTheDocument();
  });
});
