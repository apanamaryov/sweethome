import { DICTS } from "@/lib/i18n/dict";
import { chartData, endReasonLabel, faultLabel, fmtHm, startRun, stateLabel, stateTone } from "./dryer";
import { buildNode } from "@/test-utils/dryer";

const t = DICTS.ru;

describe("labels", () => {
  it("состояние: offline перекрывает любое состояние", () => {
    expect(stateLabel(t, buildNode({ online: false, state: "drying" }))).toBe("Нет связи");
    expect(stateLabel(t, buildNode({ state: "drying" }))).toBe("Сушка");
    expect(stateLabel(t, buildNode({ state: null }))).toBe("Нет связи");
    expect(stateTone(buildNode({ state: "fault" }))).toBe("bad");
    expect(stateTone(buildNode({ online: false }))).toBe("bad");
    expect(stateTone(buildNode({ state: "heating" }))).toBe("amber");
    expect(stateTone(buildNode({ state: "drying" }))).toBe("ok");
    expect(stateTone(buildNode({ state: "idle" }))).toBe("muted");
  });
  it("fault:* расшифровывается, неизвестное — общий текст с кодом", () => {
    expect(faultLabel(t, "fault:exhaust")).toBe("Вытяжка не крутится");
    expect(faultLabel(t, "fault:node_reboot_loop")).toBe("Нода перезагружается по кругу");
    expect(faultLabel(t, "fault:zzz")).toBe("Ошибка ноды: zzz");
    expect(faultLabel(t, null)).toBe("Ошибка ноды");
  });
  it("причина завершения и длительность", () => {
    expect(endReasonLabel(t, "autostop")).toBe("автостоп");
    expect(endReasonLabel(t, "fault:sensor")).toBe("ошибка: Датчик не отвечает");
    expect(endReasonLabel(t, null)).toBe("идёт");
    expect(fmtHm(3 * 3600_000 + 12 * 60_000)).toBe("3:12");
    expect(fmtHm(5 * 60_000)).toBe("0:05");
  });
});

describe("chartData", () => {
  it("секунды, камера, уставка константой, избыток, нагрев; null остаётся null", () => {
    const d = chartData(
      [
        { ts: 1000, runId: 1, chamberTemp: 50, chamberRh: 40, ambientTemp: 22, ambientRh: 50, plateTemp: 70, excess: 20, heaterDuty: 100, exhaustDuty: 25, exhaustRpm: 1000, state: "heating" },
        { ts: 11000, runId: 1, chamberTemp: null, chamberRh: null, ambientTemp: 22, ambientRh: 50, plateTemp: 72, excess: null, heaterDuty: 90, exhaustDuty: 25, exhaustRpm: 1000, state: "heating" },
      ],
      60
    );
    expect(d[0]).toEqual([1, 11]);
    expect(d[1]).toEqual([50, null]);
    expect(d[2]).toEqual([60, 60]);
    expect(d[3]).toEqual([20, null]);
    expect(d[4]).toEqual([100, 90]);
  });
});

describe("startRun", () => {
  it("бросает серверный текст ошибки как есть", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false, status: 409, json: async () => ({ ok: false, code: "already_running", error: "Сушка уже идёт" }) } as Response)
    ) as unknown as typeof fetch;
    await expect(startRun({ presetId: 1 })).rejects.toThrow("Сушка уже идёт");
  });
});
