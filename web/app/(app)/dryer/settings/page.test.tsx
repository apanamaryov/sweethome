import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import { DEFAULT_SETTINGS } from "@sweethome/dryer-shared";
import { DICTS } from "@/lib/i18n/dict";
import SettingsPage from "./page";

const t = DICTS.uk;
const toast = jest.fn();
jest.mock("@/lib/toast", () => ({ useToast: () => ({ toast }) }));

const PRESETS = [{ id: 1, name: "Яблоки", group: "fruit", setpoint: 60, maxMinutes: 840, autostop: true, sort: 1 }];
const calls: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
  calls.length = 0;
  global.fetch = jest.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/presets") && !init) return Promise.resolve({ ok: true, status: 200, json: async () => ({ presets: PRESETS }) } as Response);
    if (url.endsWith("/settings") && !init) return Promise.resolve({ ok: true, status: 200, json: async () => ({ settings: DEFAULT_SETTINGS }) } as Response);
    if (url.endsWith("/settings") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      if (body.exhaustMin === 5) return Promise.resolve({ ok: false, status: 400, json: async () => ({ ok: false, error: "Поле «минимум вытяжки» вне допустимого диапазона 20…100" }) } as Response);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ settings: { ...DEFAULT_SETTINGS, ...body } }) } as Response);
    }
    if (url.includes("/presets/1") && init?.method === "PUT") return Promise.resolve({ ok: true, status: 200, json: async () => ({ preset: { ...PRESETS[0], setpoint: 57 } }) } as Response);
    if (url.endsWith("/presets") && init?.method === "POST") return Promise.resolve({ ok: true, status: 201, json: async () => ({ preset: { id: 2, ...JSON.parse(String(init.body)), sort: 2 } }) } as Response);
    if (url.includes("/presets/1") && init?.method === "DELETE") return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) } as Response);
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
  }) as unknown as typeof fetch;
});

describe("настройки сушилки", () => {
  it("настройки: PUT с частичным патчем, тост «Сохранено»", async () => {
    render(<SettingsPage />);
    await act(async () => {});
    const hold = screen.getByLabelText(t.dryerHoldMinutes) as HTMLInputElement;
    fireEvent.change(hold, { target: { value: "45" } });
    fireEvent.click(screen.getAllByRole("button", { name: t.dryerSave })[0]);
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PUT" && c.url.endsWith("/settings"))).toBe(true));
    const put = calls.find((c) => c.init?.method === "PUT" && c.url.endsWith("/settings"))!;
    expect(JSON.parse(String(put.init!.body))).toEqual({ autostop: { holdMinutes: 45 } });
    await waitFor(() => expect(toast).toHaveBeenCalledWith(t.dryerSaved, "ok"));
  });

  it("ошибка сервера показывается дословно, поле не сбрасывается", async () => {
    render(<SettingsPage />);
    await act(async () => {});
    const em = screen.getByLabelText(t.dryerExhaustMin) as HTMLInputElement;
    fireEvent.change(em, { target: { value: "5" } });
    fireEvent.click(screen.getAllByRole("button", { name: t.dryerSave })[0]);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Поле «минимум вытяжки» вне допустимого диапазона 20…100", "bad"));
    expect(em.value).toBe("5");
  });

  it("пресеты: изменить, добавить, удалить", async () => {
    render(<SettingsPage />);
    await act(async () => {});
    const row = screen.getByDisplayValue("Яблоки").closest(".dryer-form-row")!;
    const sp = row.querySelector('input[name="setpoint"]') as HTMLInputElement;
    fireEvent.change(sp, { target: { value: "57" } });
    fireEvent.click(row.querySelector("button.apply")!);
    await waitFor(() => expect(calls.some((c) => c.url.includes("/presets/1") && c.init?.method === "PUT")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: t.dryerAddPreset }));
    const newRow = screen.getAllByPlaceholderText(t.dryerPresetName).at(-1)!.closest(".dryer-form-row")!;
    fireEvent.change(newRow.querySelector('input[name="name"]')!, { target: { value: "Инжир" } });
    fireEvent.click(newRow.querySelector("button.apply")!);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/presets") && c.init?.method === "POST")).toBe(true));
    fireEvent.click(row.querySelector("button.btn-danger")!);
    await waitFor(() => expect(calls.some((c) => c.url.includes("/presets/1") && c.init?.method === "DELETE")).toBe(true));
  });
});
