import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, restoreLocation } from "@/test-utils/renderWithProviders";
import { DICTS } from "@/lib/i18n/dict";
import DiagnosticsPage from "./page";

const t = DICTS.uk;

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  restoreLocation();
});

async function renderDiagnostics() {
  return renderWithProviders(<DiagnosticsPage />, { withSnapshot: false, withMeta: false });
}

describe("DiagnosticsPage", () => {
  it("renders the raw-query panel with an input and send button", async () => {
    await renderDiagnostics();

    expect(screen.getByText(t.panelAdvanced)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("R 201 10")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.send })).toBeInTheDocument();
  });

  it("sends the uppercased, trimmed command and renders the reply", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ ok: true, reply: "01 03 02 00 03" }) });
    const user = userEvent.setup();
    await renderDiagnostics();

    await user.type(screen.getByPlaceholderText("R 201 10"), "  r 201 1  ");
    await user.click(screen.getByRole("button", { name: t.send }));

    expect(await screen.findByText("01 03 02 00 03")).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/raw",
      expect.objectContaining({ body: JSON.stringify({ command: "R 201 1" }) })
    );
  });

  it("pressing Enter in the input also sends the command", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ ok: true, reply: "ACK" }) });
    const user = userEvent.setup();
    await renderDiagnostics();

    await user.type(screen.getByPlaceholderText("R 201 10"), "R 201 1{Enter}");

    expect(await screen.findByText("ACK")).toBeInTheDocument();
  });

  it("does nothing when the command is blank", async () => {
    const user = userEvent.setup();
    await renderDiagnostics();

    await user.click(screen.getByRole("button", { name: t.send }));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("shows the error reply prefixed with the localized error label", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error: "bad address" }),
    });
    const user = userEvent.setup();
    await renderDiagnostics();

    await user.type(screen.getByPlaceholderText("R 201 10"), "W 999 1");
    await user.click(screen.getByRole("button", { name: t.send }));

    expect(await screen.findByText(t.toastError + ": bad address")).toBeInTheDocument();
  });

  it("shows a network-error message when the fetch itself rejects", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    await renderDiagnostics();

    await user.type(screen.getByPlaceholderText("R 201 10"), "R 201 1");
    await user.click(screen.getByRole("button", { name: t.send }));

    expect(await screen.findByText(t.toastNetErr + "offline")).toBeInTheDocument();
  });

  it("shows a pending indicator while the request is in flight", async () => {
    let resolveFetch!: (v: unknown) => void;
    (global.fetch as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    const user = userEvent.setup();
    await renderDiagnostics();

    await user.type(screen.getByPlaceholderText("R 201 10"), "R 201 1");
    await user.click(screen.getByRole("button", { name: t.send }));

    expect(screen.getByText("…")).toBeInTheDocument();

    await act(async () => {
      resolveFetch({ ok: true, json: async () => ({ ok: true, reply: "done" }) });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByText("done")).toBeInTheDocument();
  });
});
