import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PublicApiToken } from "@sweethome/inverter-shared";
import { renderWithProviders, restoreLocation } from "@/test-utils/renderWithProviders";
import { DICTS } from "@/lib/i18n/dict";
import { TokensPanel } from "./TokensPanel";

const t = DICTS.uk;

const TOKENS: PublicApiToken[] = [
  {
    id: 1,
    name: "mcp",
    prefix: "inv_abcdefgh",
    scopes: ["read", "write"],
    createdAt: 1_700_000_000_000,
    lastUsedAt: null,
    expiresAt: null,
  },
];

function jsonOk(body: unknown) {
  return { ok: true, json: async () => body };
}

let confirmSpy: jest.SpyInstance;

beforeEach(() => {
  confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  restoreLocation();
  confirmSpy.mockRestore();
});

async function render(fetchImpl: jest.Mock) {
  global.fetch = fetchImpl as unknown as typeof fetch;
  return renderWithProviders(<TokensPanel />, { withSnapshot: false, withMeta: false });
}

describe("TokensPanel", () => {
  it("lists tokens with prefix, scopes and 'never used' marker", async () => {
    await render(jest.fn().mockResolvedValue(jsonOk(TOKENS)));

    const row = (await screen.findByText("mcp")).closest<HTMLElement>(".token-card")!;
    expect(within(row).getByText("inv_abcdefgh")).toBeInTheDocument();
    expect(within(row).getByText(new RegExp(t.tokensNeverUsed))).toBeInTheDocument();
    expect(within(row).getByText(new RegExp(t.tokensNever + "$"))).toBeInTheDocument();
    expect(within(row).getByText(t.tokensScopeWrite)).toBeInTheDocument();
  });

  it("shows the created token value exactly once", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonOk([])) // первичная загрузка
      .mockResolvedValueOnce(jsonOk({ ok: true, token: "inv_secret", record: TOKENS[0] })) // POST
      .mockResolvedValueOnce(jsonOk(TOKENS)); // перезагрузка списка
    await render(fetchMock);

    await screen.findByText(t.tokensEmpty);
    await userEvent.type(screen.getByPlaceholderText(t.tokensName), "mcp");
    await userEvent.click(screen.getByRole("button", { name: t.tokensAdd }));

    expect(await screen.findByText("inv_secret")).toBeInTheDocument();
    expect(screen.getByText(t.tokensCopyHint)).toBeInTheDocument();

    const postCall = fetchMock.mock.calls[1];
    expect(postCall[0]).toBe("/api/tokens");
    expect(JSON.parse(postCall[1].body)).toEqual({ name: "mcp", scopes: ["read"] });
  });

  it("sends the write scope and an expiry when asked", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonOk([]))
      .mockResolvedValueOnce(jsonOk({ ok: true, token: "inv_secret", record: TOKENS[0] }))
      .mockResolvedValueOnce(jsonOk(TOKENS));
    await render(fetchMock);

    await screen.findByText(t.tokensEmpty);
    await userEvent.type(screen.getByPlaceholderText(t.tokensName), "bot");
    await userEvent.type(screen.getByPlaceholderText(t.tokensDays), "30");
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: t.tokensAdd }));

    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      name: "bot",
      scopes: ["read", "write"],
      expiresInDays: 30,
    });
  });

  it("revokes a token after confirmation", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonOk(TOKENS))
      .mockResolvedValueOnce(jsonOk({ ok: true }))
      .mockResolvedValueOnce(jsonOk([]));
    await render(fetchMock);

    const row = (await screen.findByText("mcp")).closest<HTMLElement>(".token-card")!;
    await userEvent.click(within(row).getByRole("button", { name: t.tokensRevoke }));

    await waitFor(() => expect(fetchMock.mock.calls[1][0]).toBe("/api/tokens/1"));
    expect(fetchMock.mock.calls[1][1].method).toBe("DELETE");
    expect(await screen.findByText(t.tokensEmpty)).toBeInTheDocument();
  });

  it("keeps the token when the confirmation is declined", async () => {
    confirmSpy.mockReturnValue(false);
    const fetchMock = jest.fn().mockResolvedValue(jsonOk(TOKENS));
    await render(fetchMock);

    const row = (await screen.findByText("mcp")).closest<HTMLElement>(".token-card")!;
    await userEvent.click(within(row).getByRole("button", { name: t.tokensRevoke }));

    expect(fetchMock).toHaveBeenCalledTimes(1); // только первичная загрузка
  });
});
