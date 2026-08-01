import { ReactNode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LangProvider } from "@/lib/i18n";
import { DICTS } from "@/lib/i18n/dict";
import type { Snapshot, SessionUser } from "@sweethome/inverter-shared";
import {
  buildSession,
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
  opts: { session?: SessionUser | null; snapshot?: Snapshot | null; pathname?: string } = {}
) {
  const { session = buildSession("admin"), snapshot = buildSnapshot(), pathname = "/" } = opts;
  setMockPathname(pathname);
  setLocation({});
  installFakeWebSocket();
  wrapProviderFetch({ snapshot, session });

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

describe("AppLayout (system) — SystemNav role-based visibility", () => {
  it("admin sees Overview, Inverter and Users", async () => {
    const { container } = await renderLayout(<div>child</div>, { session: buildSession("admin"), pathname: "/" });

    const nav = within(container.querySelector<HTMLElement>(".nav-sections")!);
    expect(nav.getByText(t.navOverview)).toBeInTheDocument();
    expect(nav.getByText(t.navInverter)).toBeInTheDocument();
    expect(nav.getByText(t.navUsers)).toBeInTheDocument();
  });

  it("viewer sees Overview and Inverter, but not Users", async () => {
    const { container } = await renderLayout(<div>child</div>, { session: buildSession("viewer"), pathname: "/" });

    const nav = within(container.querySelector<HTMLElement>(".nav-sections")!);
    expect(nav.getByText(t.navOverview)).toBeInTheDocument();
    expect(nav.getByText(t.navInverter)).toBeInTheDocument();
    expect(nav.queryByText(t.navUsers)).not.toBeInTheDocument();
  });

  it("marks the Overview link active on / and the Inverter link active under /inverter/*", async () => {
    const { container } = await renderLayout(<div>child</div>, { pathname: "/inverter/stats" });

    const nav = within(container.querySelector<HTMLElement>(".nav-sections")!);
    expect(nav.getByText(t.navInverter).closest("a")).toHaveClass("active");
    expect(nav.getByText(t.navOverview).closest("a")).not.toHaveClass("active");
  });
});

describe("AppLayout (system) — admin-only guard", () => {
  it("redirects a viewer away (to /) when the current path is an admin-only page", async () => {
    await renderLayout(<div>child</div>, { session: buildSession("viewer"), pathname: "/inverter/settings" });

    await waitFor(() => expect(window.location.href).toBe("/"));
  });

  it.each(["/inverter/diagnostics", "/users"])("also redirects a viewer away from %s", async (path) => {
    await renderLayout(<div>child</div>, { session: buildSession("viewer"), pathname: path });

    await waitFor(() => expect(window.location.href).toBe("/"));
  });

  it("does not redirect an admin on the same admin-only page", async () => {
    await renderLayout(<div>child</div>, { session: buildSession("admin"), pathname: "/inverter/settings" });

    await flushMicrotasks();
    expect(window.location.href).toBe("");
  });

  it("does not redirect a viewer on a non-admin page (overview)", async () => {
    await renderLayout(<div>child</div>, { session: buildSession("viewer"), pathname: "/" });

    await flushMicrotasks();
    expect(window.location.href).toBe("");
  });
});

describe("AppLayout (system) — SystemFooter", () => {
  it("shows an em dash before the session has loaded", async () => {
    jest.useFakeTimers();
    try {
      wrapProviderFetch({ snapshot: buildSnapshot(), session: null }); // /api/me rejects -> stays loading
      setMockPathname("/");
      setLocation({});
      installFakeWebSocket();

      await act(async () => {
        render(
          <LangProvider>
            <AppLayout>
              <div>child</div>
            </AppLayout>
          </LangProvider>
        );
        await flushMicrotasks();
      });

      expect(screen.getByText("—")).toBeInTheDocument();
      expect(screen.queryByText(t.logout)).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it("shows the username once the session has loaded, which POSTs /api/logout and redirects to /login", async () => {
    const user = userEvent.setup();
    await renderLayout(<div>child</div>, { session: buildSession("admin", { username: "alice" }) });

    expect(screen.getByText("alice")).toBeInTheDocument();
    const logoutLink = screen.getByText(t.logout);
    await user.click(logoutLink);

    await waitFor(() => expect(window.location.href).toBe("/login"));
  });
});

describe("AppLayout (system) — renders children", () => {
  it("renders the page content passed as children alongside the system chrome", async () => {
    await renderLayout(<div data-testid="page-body">hello</div>);

    expect(screen.getByTestId("page-body")).toBeInTheDocument();
  });
});
