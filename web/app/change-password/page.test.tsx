import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, setLocation, restoreLocation } from "@/test-utils/renderWithProviders";
import { DICTS } from "@/lib/i18n/dict";
import ChangePasswordPage from "./page";

const t = DICTS.uk;

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  restoreLocation();
});

async function fillForm(user: ReturnType<typeof userEvent.setup>, current: string, next: string, confirm: string) {
  await user.type(screen.getByPlaceholderText(t.changePwCurrent), current);
  await user.type(screen.getByPlaceholderText(t.changePwNew), next);
  await user.type(screen.getByPlaceholderText(t.changePwConfirm), confirm);
}

describe("ChangePasswordPage", () => {
  it("renders the current/new/confirm password form", async () => {
    await renderWithProviders(<ChangePasswordPage />, { withSnapshot: false, withMeta: false });

    expect(screen.getByText(t.changePwTitle)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(t.changePwCurrent)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(t.changePwNew)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(t.changePwConfirm)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.changePwSubmit })).toBeInTheDocument();
  });

  it("rejects a new password shorter than 6 characters without calling the API", async () => {
    const user = userEvent.setup();
    await renderWithProviders(<ChangePasswordPage />, { withSnapshot: false, withMeta: false });

    await fillForm(user, "old", "abc", "abc");
    await user.click(screen.getByRole("button", { name: t.changePwSubmit }));

    expect(await screen.findByText(t.changePwMismatch)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects mismatched confirmation without calling the API", async () => {
    const user = userEvent.setup();
    await renderWithProviders(<ChangePasswordPage />, { withSnapshot: false, withMeta: false });

    await fillForm(user, "old", "newpass1", "newpass2");
    await user.click(screen.getByRole("button", { name: t.changePwSubmit }));

    expect(await screen.findByText(t.changePwNoMatch)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("submits to /api/change-password and redirects to / on success", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    setLocation({});
    const user = userEvent.setup();
    await renderWithProviders(<ChangePasswordPage />, { withSnapshot: false, withMeta: false });

    await fillForm(user, "old", "newpass1", "newpass1");
    await user.click(screen.getByRole("button", { name: t.changePwSubmit }));

    await waitFor(() => expect(window.location.href).toBe("/"));
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/change-password",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ currentPassword: "old", newPassword: "newpass1" }),
      })
    );
  });

  it("shows the server error message when the API rejects the change", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error: "Current password is wrong" }),
    });
    const user = userEvent.setup();
    await renderWithProviders(<ChangePasswordPage />, { withSnapshot: false, withMeta: false });

    await fillForm(user, "wrong", "newpass1", "newpass1");
    await user.click(screen.getByRole("button", { name: t.changePwSubmit }));

    expect(await screen.findByText("Current password is wrong")).toBeInTheDocument();
  });

  it("shows a network-error message when the fetch itself rejects", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    await renderWithProviders(<ChangePasswordPage />, { withSnapshot: false, withMeta: false });

    await fillForm(user, "old", "newpass1", "newpass1");
    await user.click(screen.getByRole("button", { name: t.changePwSubmit }));

    expect(await screen.findByText(t.toastNetErr + "offline")).toBeInTheDocument();
  });
});
