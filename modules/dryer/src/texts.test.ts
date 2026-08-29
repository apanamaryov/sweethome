import { endReasonText, faultText, fmtDuration, runTitle } from "./texts";

describe("texts", () => {
  it("расшифровывает fault:* по-русски и не ломается на незнакомом", () => {
    expect(faultText("fault:plate_overheat")).toBe("перегрев пластины (> 110 °C)");
    expect(faultText("fault:exhaust")).toBe("вытяжка не крутится");
    expect(faultText("fault:node_reboot_loop")).toBe("нода перезагружается по кругу");
    expect(faultText("fault:mystery")).toBe("ошибка ноды: mystery");
  });

  it("длительность — часы и минуты, без секунд", () => {
    expect(fmtDuration(9 * 3600_000 + 40 * 60_000)).toBe("9 ч 40 м");
    expect(fmtDuration(40 * 60_000)).toBe("40 м");
    expect(fmtDuration(59_000)).toBe("0 м");
    expect(fmtDuration(2 * 3600_000)).toBe("2 ч 0 м");
  });

  it("название сушки — пресет в кавычках либо «свои параметры»", () => {
    expect(runTitle("Яблоки")).toBe("«Яблоки»");
    expect(runTitle(null)).toBe("«свои параметры»");
  });

  it("причина завершения — человеческим языком", () => {
    expect(endReasonText("autostop")).toBe("завершена автостопом");
    expect(endReasonText("stopped")).toBe("остановлена");
    expect(endReasonText("timeout")).toBe("остановлена по таймеру");
    expect(endReasonText("node_lost")).toBe("закрыта: связь с нодой потеряна");
    expect(endReasonText("fault:sensor")).toBe("прервана: датчик не отвечает");
  });
});
