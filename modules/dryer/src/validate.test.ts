import { validatePresetInput, validatePresetPatch, validateSettingsPatch, validateStartRequest } from "./validate";

const ok = <T>(v: { ok: boolean; value?: T }) => {
  expect(v.ok).toBe(true);
  return v.value as T;
};
const bad = (v: { ok: boolean; error?: string }) => {
  expect(v.ok).toBe(false);
  return v.error as string;
};

describe("validatePresetInput", () => {
  it("принимает полный корректный пресет и нормализует имя", () => {
    const p = ok(validatePresetInput({ name: "  Яблоки ", group: "fruit", setpoint: 60, maxMinutes: 840, autostop: true }));
    expect(p).toEqual({ name: "Яблоки", group: "fruit", setpoint: 60, maxMinutes: 840, autostop: true });
  });
  it("autostop по умолчанию true", () => {
    expect(ok(validatePresetInput({ name: "A", group: "other", setpoint: 40, maxMinutes: 60 })).autostop).toBe(true);
  });
  it("отвергает пустое имя, чужую группу, диапазоны — русским текстом", () => {
    expect(bad(validatePresetInput({ name: " ", group: "fruit", setpoint: 60, maxMinutes: 60 }))).toBe("Поле «название» обязательно");
    expect(bad(validatePresetInput({ name: "A", group: "meat", setpoint: 60, maxMinutes: 60 }))).toBe(
      "Поле «группа» должно быть одним из: fruit, vegetable, other"
    );
    expect(bad(validatePresetInput({ name: "A", group: "fruit", setpoint: 80, maxMinutes: 60 }))).toBe(
      "Поле «уставка» вне допустимого диапазона 35…75"
    );
    expect(bad(validatePresetInput({ name: "A", group: "fruit", setpoint: 60, maxMinutes: 10 }))).toBe(
      "Поле «максимум минут» вне допустимого диапазона 30…2880"
    );
    expect(bad(validatePresetInput({ name: "A", group: "fruit", setpoint: 60, maxMinutes: 60.5 }))).toBe(
      "Поле «максимум минут» должно быть целым числом"
    );
    expect(bad(validatePresetInput(null))).toBe("Ожидается объект");
  });
});

describe("validatePresetPatch", () => {
  it("принимает частичный объект, пустой патч отвергает", () => {
    expect(ok(validatePresetPatch({ setpoint: 55 }))).toEqual({ setpoint: 55 });
    expect(bad(validatePresetPatch({}))).toBe("Нет ни одного поля для изменения");
    expect(bad(validatePresetPatch({ setpoint: 20 }))).toBe("Поле «уставка» вне допустимого диапазона 35…75");
  });
});

describe("validateSettingsPatch", () => {
  it("принимает вложенный autostop и плоские поля", () => {
    expect(ok(validateSettingsPatch({ autostop: { holdMinutes: 45 }, exhaustMin: 30 }))).toEqual({
      autostop: { holdMinutes: 45 },
      exhaustMin: 30,
    });
  });
  it("проверяет каждый диапазон", () => {
    expect(bad(validateSettingsPatch({ autostop: { excessThreshold: 0.1 } }))).toBe(
      "Поле «порог избытка» вне допустимого диапазона 0.5…15"
    );
    expect(bad(validateSettingsPatch({ exhaustMin: 10 }))).toBe("Поле «минимум вытяжки» вне допустимого диапазона 20…100");
    expect(bad(validateSettingsPatch({ exhaustGain: 25 }))).toBe("Поле «коэффициент вытяжки» вне допустимого диапазона 0…20");
    expect(bad(validateSettingsPatch({ staleAfterSeconds: 10 }))).toBe("Поле «устаревание данных» вне допустимого диапазона 30…300");
    expect(bad(validateSettingsPatch({ autostop: { minRunMinutes: -1 } }))).toBe(
      "Поле «минимальное время сушки» вне допустимого диапазона 0…600"
    );
    expect(bad(validateSettingsPatch({ nothing: 1 }))).toBe("Нет ни одного поля для изменения");
  });
});

describe("validateStartRequest", () => {
  it("пресет либо свои параметры", () => {
    expect(ok(validateStartRequest({ presetId: 3 }))).toEqual({ presetId: 3 });
    expect(ok(validateStartRequest({ setpoint: 60, maxMinutes: 600 }))).toEqual({ setpoint: 60, maxMinutes: 600 });
    expect(ok(validateStartRequest({ setpoint: 60, maxMinutes: 600, autostop: false }))).toEqual({
      setpoint: 60,
      maxMinutes: 600,
      autostop: false,
    });
  });
  it("отвергает пустоту, смесь и половину своих параметров", () => {
    expect(bad(validateStartRequest({}))).toBe("Укажи пресет либо уставку и максимум минут");
    expect(bad(validateStartRequest({ presetId: 1, setpoint: 60 }))).toBe("Укажи пресет либо уставку и максимум минут, но не оба");
    expect(bad(validateStartRequest({ setpoint: 60 }))).toBe("Укажи пресет либо уставку и максимум минут");
    expect(bad(validateStartRequest({ presetId: 1.5 }))).toBe("Поле «пресет» должно быть целым числом");
  });
});
