import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, setLocation, restoreLocation } from "@/test-utils/renderWithProviders";
import { DICTS } from "@/lib/i18n/dict";
import LoginPage from "./page";

const t = DICTS.uk;

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  restoreLocation();
});

describe("LoginPage", () => {
  it("renders the username/password form", async () => {
    await renderWithProviders(<LoginPage />, { withSnapshot: false, withMeta: false });

    expect(screen.getByText(t.h1)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(t.loginUsername)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(t.loginPassword)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.loginSubmit })).toBeInTheDocument();
  });

  it("submits credentials to /api/login and redirects to / on a plain success", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, mustChangePassword: false }),
    });
    setLocation({});
    const user = userEvent.setup();
    await renderWithProviders(<LoginPage />, { withSnapshot: false, withMeta: false });

    await user.type(screen.getByPlaceholderText(t.loginUsername), "admin");
    await user.type(screen.getByPlaceholderText(t.loginPassword), "secret");
    await user.click(screen.getByRole("button", { name: t.loginSubmit }));

    await waitFor(() => expect(window.location.href).toBe("/"));
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "secret" }),
      })
    );
  });

  it("redirects to /change-password when the server flags a forced password change", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, mustChangePassword: true }),
    });
    setLocation({});
    const user = userEvent.setup();
    await renderWithProviders(<LoginPage />, { withSnapshot: false, withMeta: false });

    await user.type(screen.getByPlaceholderText(t.loginUsername), "admin");
    await user.type(screen.getByPlaceholderText(t.loginPassword), "temp");
    await user.click(screen.getByRole("button", { name: t.loginSubmit }));

    await waitFor(() => expect(window.location.href).toBe("/change-password"));
  });

  it("shows the localized bad-password message on code=bad_password", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, code: "bad_password" }),
    });
    const user = userEvent.setup();
    await renderWithProviders(<LoginPage />, { withSnapshot: false, withMeta: false });

    await user.type(screen.getByPlaceholderText(t.loginPassword), "wrong");
    await user.click(screen.getByRole("button", { name: t.loginSubmit }));

    expect(await screen.findByText(t.badPassword)).toBeInTheDocument();
  });

  it("shows the rate-limit message with the minutes substituted in", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, code: "rate_limited", minutes: 5 }),
    });
    const user = userEvent.setup();
    await renderWithProviders(<LoginPage />, { withSnapshot: false, withMeta: false });

    await user.click(screen.getByRole("button", { name: t.loginSubmit }));

    expect(await screen.findByText(t.tooMany.replace("{m}", "5"))).toBeInTheDocument();
  });

  it("shows the raw server error message when no known code is set", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error: "Something specific broke" }),
    });
    const user = userEvent.setup();
    await renderWithProviders(<LoginPage />, { withSnapshot: false, withMeta: false });

    await user.click(screen.getByRole("button", { name: t.loginSubmit }));

    expect(await screen.findByText("Something specific broke")).toBeInTheDocument();
  });

  it("shows a network-error message when the fetch itself rejects", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    await renderWithProviders(<LoginPage />, { withSnapshot: false, withMeta: false });

    await user.click(screen.getByRole("button", { name: t.loginSubmit }));

    expect(await screen.findByText(t.toastNetErr + "offline")).toBeInTheDocument();
  });
});
