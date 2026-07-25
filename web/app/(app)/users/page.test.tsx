import { fireEvent, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PublicUser } from "@inverter/shared";
import { renderWithProviders, restoreLocation } from "@/test-utils/renderWithProviders";
import { DICTS } from "@/lib/i18n/dict";
import UsersPage from "./page";

const t = DICTS.uk;

const USERS: PublicUser[] = [
  { id: 1, username: "admin", role: "admin", mustChangePassword: false, createdAt: Date.now() },
  { id: 2, username: "bob", role: "viewer", mustChangePassword: true, createdAt: Date.now() },
];

function jsonOk(body: unknown) {
  return { ok: true, json: async () => body };
}

let promptSpy: jest.SpyInstance;
let confirmSpy: jest.SpyInstance;

beforeEach(() => {
  promptSpy = jest.spyOn(window, "prompt").mockReturnValue(null);
  confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);
});

afterEach(() => {
  restoreLocation();
  promptSpy.mockRestore();
  confirmSpy.mockRestore();
});

async function render(fetchImpl: jest.Mock) {
  global.fetch = fetchImpl as unknown as typeof fetch;
  return renderWithProviders(<UsersPage />, { withSnapshot: false, withMeta: false });
}

describe("UsersPage", () => {
  it("loads and renders the user list with role selects and per-user actions", async () => {
    await render(jest.fn().mockResolvedValue(jsonOk(USERS)));

    expect(screen.getByText(t.usersTitle)).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
    expect(screen.getByText(t.usersMustChange)).toBeInTheDocument(); // only bob has it

    const bobCard = screen.getByText("bob").closest<HTMLElement>(".user-card")!;
    expect(within(bobCard).getByRole("combobox")).toHaveValue("viewer");
    expect(within(bobCard).getByRole("button", { name: t.usersResetPw })).toBeInTheDocument();
    expect(within(bobCard).getByRole("button", { name: t.usersDelete })).toBeInTheDocument();
  });

  it("renders the add-user form (username/password/role/submit)", async () => {
    await render(jest.fn().mockResolvedValue(jsonOk([])));

    // t.usersAdd labels both the section title and the submit button.
    expect(screen.getAllByText(t.usersAdd)).toHaveLength(2);
    expect(screen.getByRole("button", { name: t.usersAdd })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(t.loginUsername)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(t.changePwNew)).toBeInTheDocument();
  });

  it("adding a user POSTs /api/users, clears the form, and reloads the list", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonOk([])) // initial load
      .mockResolvedValueOnce(jsonOk({ ok: true })) // POST /api/users
      .mockResolvedValueOnce(jsonOk(USERS)); // reload after add
    const user = userEvent.setup();
    await render(fetchMock);

    await user.type(screen.getByPlaceholderText(t.loginUsername), "newguy");
    await user.type(screen.getByPlaceholderText(t.changePwNew), "s3cret!");
    await user.click(screen.getByRole("button", { name: t.usersAdd }));

    await waitFor(() => expect(screen.getByText("admin")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/users",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ username: "newguy", role: "viewer", password: "s3cret!" }),
      })
    );
    expect(screen.getByPlaceholderText(t.loginUsername)).toHaveValue("");
  });

  it("shows a toast and does not reload when adding a user is rejected by the server", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonOk([]))
      .mockResolvedValueOnce(jsonOk({ ok: false, error: "Username taken" }));
    const user = userEvent.setup();
    await render(fetchMock);

    await user.type(screen.getByPlaceholderText(t.loginUsername), "admin");
    await user.click(screen.getByRole("button", { name: t.usersAdd }));

    expect(await screen.findByText("Username taken")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial load + the failed POST, no reload
  });

  it("changing a user's role PATCHes /api/users/:id and reloads", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonOk(USERS))
      .mockResolvedValueOnce(jsonOk({ ok: true }))
      .mockResolvedValueOnce(jsonOk(USERS));
    const user = userEvent.setup();
    await render(fetchMock);

    const bobCard = screen.getByText("bob").closest<HTMLElement>(".user-card")!;
    await user.selectOptions(within(bobCard).getByRole("combobox"), "admin");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/users/2",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ role: "admin" }) })
    );
  });

  it("selecting the same role again is a no-op (no PATCH sent)", async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(jsonOk(USERS));
    await render(fetchMock);

    const bobCard = screen.getByText("bob").closest<HTMLElement>(".user-card")!;
    // fireEvent (not userEvent.selectOptions) so the "same value" change event
    // fires unconditionally, actually exercising the component's own
    // `if (next === u.role) return` guard rather than relying on the browser
    // to skip firing `change` for a no-op selection.
    fireEvent.change(within(bobCard).getByRole("combobox"), { target: { value: "viewer" } });

    expect(fetchMock).toHaveBeenCalledTimes(1); // only the initial load
  });

  it("reset-password prompts, then POSTs the new password and toasts OK", async () => {
    promptSpy.mockReturnValue("newpass1");
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonOk(USERS))
      .mockResolvedValueOnce(jsonOk({ ok: true }))
      .mockResolvedValueOnce(jsonOk(USERS));
    const user = userEvent.setup();
    await render(fetchMock);

    const bobCard = screen.getByText("bob").closest<HTMLElement>(".user-card")!;
    await user.click(within(bobCard).getByRole("button", { name: t.usersResetPw }));

    expect(await screen.findByText("OK")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/users/2/reset-password",
      expect.objectContaining({ body: JSON.stringify({ newPassword: "newpass1" }) })
    );
  });

  it("reset-password does nothing when the prompt is dismissed", async () => {
    promptSpy.mockReturnValue(null);
    const fetchMock = jest.fn().mockResolvedValueOnce(jsonOk(USERS));
    const user = userEvent.setup();
    await render(fetchMock);

    const bobCard = screen.getByText("bob").closest<HTMLElement>(".user-card")!;
    await user.click(within(bobCard).getByRole("button", { name: t.usersResetPw }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("delete asks for confirmation, then DELETEs and reloads", async () => {
    confirmSpy.mockReturnValue(true);
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonOk(USERS))
      .mockResolvedValueOnce(jsonOk({ ok: true }))
      .mockResolvedValueOnce(jsonOk([USERS[0]]));
    const user = userEvent.setup();
    await render(fetchMock);

    const bobCard = screen.getByText("bob").closest<HTMLElement>(".user-card")!;
    await user.click(within(bobCard).getByRole("button", { name: t.usersDelete }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/users/2", expect.objectContaining({ method: "DELETE" }));
    expect(screen.queryByText("bob")).not.toBeInTheDocument();
  });

  it("delete does nothing when the confirmation is declined", async () => {
    confirmSpy.mockReturnValue(false);
    const fetchMock = jest.fn().mockResolvedValueOnce(jsonOk(USERS));
    const user = userEvent.setup();
    await render(fetchMock);

    const bobCard = screen.getByText("bob").closest<HTMLElement>(".user-card")!;
    await user.click(within(bobCard).getByRole("button", { name: t.usersDelete }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows a toast when the initial user list load fails", async () => {
    await render(jest.fn().mockRejectedValue(new Error("network down")));

    expect(await screen.findByText("network down")).toBeInTheDocument();
  });
});
